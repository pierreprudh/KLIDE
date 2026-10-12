import { useTweenedNumber } from "../../hooks/useTweenedNumber";

/** A count that glides between values — a row of the context gauge while a
 *  turn streams. `format` sees the in-flight value, so a formatter that
 *  rounds to "12.4k" rounds the tween too and the text never flickers through
 *  fractional tokens. */
export function TweenedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const shown = useTweenedNumber(value);
  return <>{format(shown)}</>;
}
