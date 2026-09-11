//! UTF-8 framing for PTY reads.
//!
//! A PTY hands us bytes in whatever sizes the kernel buffer happens to hold,
//! and a multi-byte character (an accented letter, a box-drawing glyph, an
//! emoji in a spinner) can straddle two reads. Decoding each read on its own
//! with `from_utf8_lossy` turns both halves into U+FFFD — the replacement
//! character the terminal then paints as `�`. The framer keeps the incomplete
//! tail back and prepends it to the next read, so every chunk it yields is
//! whole characters. Bytes that are simply invalid (not merely incomplete)
//! are still replaced, so a misbehaving child can never stall the stream.

/// Carries the incomplete tail of one read into the next.
#[derive(Default)]
pub struct Utf8Framer {
    pending: Vec<u8>,
}

impl Utf8Framer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode `bytes` (plus any tail held back from the previous call) into
    /// a string of whole characters. An incomplete sequence at the very end is
    /// kept for the next call instead of being replaced.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(bytes);
        let split = buf.len() - incomplete_tail_len(&buf);
        self.pending = buf.split_off(split);
        String::from_utf8(buf).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
    }

    /// The child closed its side: whatever tail is still pending will never
    /// be completed, so hand it over lossily.
    pub fn finish(&mut self) -> String {
        let tail = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&tail).into_owned()
    }
}

/// How many bytes at the end of `buf` form the start of a multi-byte sequence
/// that has not yet received all its continuation bytes. Zero when the buffer
/// ends on a character boundary or on bytes that can never be completed.
fn incomplete_tail_len(buf: &[u8]) -> usize {
    // A sequence is at most 4 bytes, so only the last 3 can be an incomplete
    // start. Walk back to the nearest lead byte and see if it is short.
    let start = buf.len().saturating_sub(3);
    for i in (start..buf.len()).rev() {
        let b = buf[i];
        if b & 0b1100_0000 == 0b1000_0000 {
            continue; // continuation byte — keep looking for its lead
        }
        let need = match b {
            0b1100_0000..=0b1101_1111 => 2,
            0b1110_0000..=0b1110_1111 => 3,
            0b1111_0000..=0b1111_0111 => 4,
            _ => return 0, // ASCII or an invalid lead: nothing to wait for
        };
        let have = buf.len() - i;
        return if have < need { have } else { 0 };
    }
    0
}

/// Trim the front of a byte ring so it starts on a character boundary:
/// skip continuation bytes left behind when a cap cut a sequence in half.
pub fn skip_partial_char_prefix(bytes: &mut std::collections::VecDeque<u8>) {
    while matches!(bytes.front(), Some(b) if b & 0b1100_0000 == 0b1000_0000) {
        bytes.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_split_across_two_reads_is_decoded_whole() {
        let mut f = Utf8Framer::new();
        let bytes = "é".as_bytes(); // 2 bytes
        assert_eq!(f.push(&bytes[..1]), "");
        assert_eq!(f.push(&bytes[1..]), "é");
    }

    #[test]
    fn an_emoji_split_three_ways_is_decoded_whole() {
        let mut f = Utf8Framer::new();
        let bytes = "a🦀b".as_bytes(); // 1 + 4 + 1
        assert_eq!(f.push(&bytes[..2]), "a");
        assert_eq!(f.push(&bytes[2..4]), "");
        assert_eq!(f.push(&bytes[4..]), "🦀b");
    }

    #[test]
    fn whole_reads_pass_through_unchanged() {
        let mut f = Utf8Framer::new();
        assert_eq!(f.push("plain ascii ─ box ✓".as_bytes()), "plain ascii ─ box ✓");
        assert_eq!(f.finish(), "");
    }

    #[test]
    fn invalid_bytes_are_replaced_not_held() {
        let mut f = Utf8Framer::new();
        // A lone continuation byte, and a lead byte followed by ASCII.
        assert_eq!(f.push(&[0x80, b'x']), "\u{FFFD}x");
        assert_eq!(f.push(&[0xE2, b'y']), "\u{FFFD}y");
    }

    #[test]
    fn a_tail_pending_at_eof_is_flushed_lossily() {
        let mut f = Utf8Framer::new();
        assert_eq!(f.push(&[b'a', 0xE2, 0x94]), "a");
        assert_eq!(f.finish(), "\u{FFFD}");
        assert_eq!(f.finish(), "");
    }

    #[test]
    fn ring_trim_skips_a_half_character_at_the_front() {
        let mut ring: std::collections::VecDeque<u8> = "─x".as_bytes().iter().copied().collect();
        ring.pop_front(); // cut the 3-byte glyph after its lead byte
        skip_partial_char_prefix(&mut ring);
        assert_eq!(ring.iter().copied().collect::<Vec<u8>>(), b"x");
    }
}
