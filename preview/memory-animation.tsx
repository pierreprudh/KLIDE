import { createRoot } from "react-dom/client";
import "./memory-animation.css";

function MemoryAnimation() {
  return (
    <main className="memory-animation">
      <svg
        className="memory-diagram"
        viewBox="0 0 900 480"
        role="img"
        aria-labelledby="memory-title memory-description"
      >
        <title id="memory-title">Foundations become Project memory</title>
        <desc id="memory-description">
          Context from conversations across providers gathers in Foundations. A reviewed lesson moves into lasting Project memory.
        </desc>

        <defs>
          <filter id="paper-shadow" x="-20%" y="-20%" width="140%" height="150%">
            <feDropShadow dx="0" dy="7" stdDeviation="9" floodColor="var(--shadow)" floodOpacity=".45" />
          </filter>
        </defs>

        <text className="eyebrow" x="54" y="85">CONVERSATIONS</text>
        <text className="eyebrow" x="54" y="101">ACROSS PROVIDERS</text>

        <g className="conversation conversation-a">
          <rect className="conversation-paper" x="47" y="124" width="174" height="58" rx="8" />
          <circle className="provider-dot provider-a" cx="65" cy="144" r="4" />
          <text className="conversation-title" x="77" y="147">Architecture</text>
          <path className="conversation-line" d="M64 161h123" />
          <path className="conversation-line short" d="M64 169h81" />
        </g>
        <g className="conversation conversation-b">
          <rect className="conversation-paper" x="47" y="216" width="174" height="58" rx="8" />
          <circle className="provider-dot provider-b" cx="65" cy="236" r="4" />
          <text className="conversation-title" x="77" y="239">Product direction</text>
          <path className="conversation-line" d="M64 253h123" />
          <path className="conversation-line short" d="M64 261h81" />
        </g>
        <g className="conversation conversation-c">
          <rect className="conversation-paper" x="47" y="308" width="174" height="58" rx="8" />
          <circle className="provider-dot provider-c" cx="65" cy="328" r="4" />
          <text className="conversation-title" x="77" y="331">Implementation</text>
          <path className="conversation-line" d="M64 345h123" />
          <path className="conversation-line short" d="M64 353h81" />
        </g>

        <g className="context-flow">
          <path className="flow-line" d="M221 153 C266 153 276 208 326 225" />
          <path className="flow-line" d="M221 245 C266 245 281 245 326 245" />
          <path className="flow-line" d="M221 337 C266 337 276 282 326 265" />
          <circle className="signal signal-a" r="3"><animateMotion dur="3.8s" repeatCount="indefinite" path="M221 153 C266 153 276 208 326 225" /></circle>
          <circle className="signal signal-b" r="3"><animateMotion dur="3.1s" repeatCount="indefinite" path="M221 245 C266 245 281 245 326 245" /></circle>
          <circle className="signal signal-c" r="3"><animateMotion dur="4.2s" repeatCount="indefinite" path="M221 337 C266 337 276 282 326 265" /></circle>
        </g>

        <g className="foundation" filter="url(#paper-shadow)">
          <rect className="foundation-back" x="345" y="139" width="216" height="210" rx="11" />
          <rect className="foundation-sheet" x="333" y="129" width="216" height="210" rx="11" />
          <path className="foundation-rule" d="M357 183h168" />
          <text className="card-label" x="357" y="164">FOUNDATIONS</text>
          <text className="card-subtitle" x="357" y="178">SHARED WORKING CONTEXT</text>

          <g className="note note-first">
            <circle className="note-bullet" cx="363" cy="211" r="3" />
            <path className="note-line" d="M375 211h137" />
          </g>
          <g className="note note-selected">
            <rect className="selected-wash" x="348" y="222" width="186" height="51" rx="5" />
            <circle className="selected-bullet" cx="363" cy="240" r="3.5" />
            <text className="lesson-name" x="375" y="240">Resume after reconnects</text>
            <text className="lesson-detail" x="375" y="253">Replay completed results</text>
            <text className="selected-caption" x="375" y="265">REVIEW THIS LESSON</text>
          </g>
          <g className="note note-last">
            <circle className="note-bullet" cx="363" cy="289" r="3" />
            <path className="note-line" d="M375 289h137" />
          </g>
        </g>

        <path className="promotion-path" d="M533 244 C596 244 652 277 770 277" />
        <circle className="promotion-pulse pulse-one" r="3"><animateMotion dur="4.8s" repeatCount="indefinite" path="M533 244 C596 244 652 277 770 277" /></circle>
        <circle className="promotion-pulse pulse-two" r="2"><animateMotion dur="4.8s" begin="1.6s" repeatCount="indefinite" path="M533 244 C596 244 652 277 770 277" /></circle>

        <g className="memory" filter="url(#paper-shadow)">
          <path className="memory-back" d="M689 169h53l12 13h89a10 10 0 0 1 10 10v140a10 10 0 0 1-10 10H689a10 10 0 0 1-10-10V179a10 10 0 0 1 10-10Z" />
          <path className="memory-front" d="M679 191a10 10 0 0 1 10-10h164a10 10 0 0 1 10 10v141a10 10 0 0 1-10 10H689a10 10 0 0 1-10-10Z" />
          <text className="card-label" x="701" y="216">PROJECT MEMORY</text>
          <text className="card-subtitle" x="701" y="231">REVIEWED KNOWLEDGE</text>
          <path className="memory-rule" d="M701 243h139" />
          <g className="saved-lesson">
            <rect className="saved-wash" x="696" y="253" width="148" height="49" rx="5" />
            <text className="saved-name" x="707" y="270">Resume after reconnects</text>
            <text className="saved-detail" x="707" y="284">Replay completed results</text>
            <path className="saved-check" d="m819 268 4 4 8-9" />
          </g>
          <text className="memory-foot" x="701" y="321">KEPT FOR FUTURE WORK</text>
        </g>

        <g className="moving-lesson" transform="translate(550 244)">
          <animateMotion
            dur="4.8s"
            repeatCount="indefinite"
            path="M550 244 C619 244 658 277 770 277"
            keyPoints="0;0;1;1"
            keyTimes="0;.2;.72;1"
            calcMode="linear"
          />
          <animate attributeName="opacity" dur="4.8s" repeatCount="indefinite" values="0;0;1;1;0" keyTimes="0;.18;.22;.66;.78" />
          <rect className="moving-paper" x="-43" y="-15" width="86" height="30" rx="5" />
          <text className="moving-paper-title" x="-34" y="1">LESSON REVIEW</text>
          <circle className="moving-paper-dot" cx="32" cy="0" r="3" />
        </g>

        <text className="eyebrow foundation-caption" x="333" y="385">EVOLVING CONTEXT</text>
        <text className="eyebrow memory-caption" x="679" y="385">REVIEWED · REUSABLE</text>
        <text className="motion-caption" x="450" y="431" textAnchor="middle">A USEFUL LESSON CARRIES FORWARD</text>
      </svg>

      <svg className="memory-diagram mobile-diagram" viewBox="0 0 460 680" role="img" aria-labelledby="mobile-memory-title mobile-memory-description">
        <title id="mobile-memory-title">Foundations become Project memory</title>
        <desc id="mobile-memory-description">Conversation context gathers in Foundations. A reviewed lesson travels into lasting Project memory.</desc>
        <defs>
          <filter id="mobile-paper-shadow" x="-20%" y="-20%" width="140%" height="150%">
            <feDropShadow dx="0" dy="6" stdDeviation="7" floodColor="var(--shadow)" floodOpacity=".45" />
          </filter>
        </defs>

        <text className="eyebrow" x="112" y="47">CONVERSATIONS · ANY PROVIDER</text>
        <g className="conversation conversation-a">
          <rect className="conversation-paper" x="112" y="62" width="236" height="34" rx="7" />
          <circle className="provider-dot provider-a" cx="130" cy="79" r="4" />
          <text className="conversation-title" x="143" y="83">Architecture</text>
          <path className="conversation-line" d="M250 80h78" />
        </g>
        <g className="conversation conversation-b">
          <rect className="conversation-paper" x="112" y="105" width="236" height="34" rx="7" />
          <circle className="provider-dot provider-b" cx="130" cy="122" r="4" />
          <text className="conversation-title" x="143" y="126">Product direction</text>
          <path className="conversation-line" d="M260 123h68" />
        </g>
        <g className="conversation conversation-c">
          <rect className="conversation-paper" x="112" y="148" width="236" height="34" rx="7" />
          <circle className="provider-dot provider-c" cx="130" cy="165" r="4" />
          <text className="conversation-title" x="143" y="169">Implementation</text>
          <path className="conversation-line" d="M252 166h76" />
        </g>

        <path className="flow-line" d="M230 182v33" />
        <circle className="signal signal-a" r="3"><animateMotion dur="3.8s" repeatCount="indefinite" path="M230 182v33" /></circle>
        <circle className="signal signal-b" r="3"><animateMotion dur="3.1s" begin="1s" repeatCount="indefinite" path="M230 182v33" /></circle>

        <g className="foundation" filter="url(#mobile-paper-shadow)">
          <rect className="foundation-back" x="102" y="217" width="256" height="184" rx="11" />
          <rect className="foundation-sheet" x="92" y="208" width="256" height="184" rx="11" />
          <text className="card-label" x="116" y="239">FOUNDATIONS</text>
          <text className="card-subtitle" x="116" y="254">SHARED WORKING CONTEXT</text>
          <path className="foundation-rule" d="M116 265h207" />
          <g className="note note-first">
            <circle className="note-bullet" cx="122" cy="286" r="3" />
            <path className="note-line" d="M136 286h172" />
          </g>
          <g className="note note-selected">
            <rect className="selected-wash" x="108" y="296" width="224" height="57" rx="5" />
            <circle className="selected-bullet" cx="123" cy="317" r="3.5" />
            <text className="lesson-name" x="136" y="317">Resume after reconnects</text>
            <text className="lesson-detail" x="136" y="330">Replay completed results</text>
            <text className="selected-caption" x="136" y="345">REVIEW THIS LESSON</text>
          </g>
          <g className="note note-last">
            <circle className="note-bullet" cx="122" cy="369" r="3" />
            <path className="note-line" d="M136 369h172" />
          </g>
        </g>

        <path className="promotion-path" d="M220 346 C220 409 220 467 220 570" />
        <circle className="promotion-pulse pulse-one" r="3"><animateMotion dur="4.8s" repeatCount="indefinite" path="M220 346 C220 409 220 467 220 570" /></circle>
        <circle className="promotion-pulse pulse-two" r="2"><animateMotion dur="4.8s" begin="1.6s" repeatCount="indefinite" path="M220 346 C220 409 220 467 220 570" /></circle>

        <g className="memory" filter="url(#mobile-paper-shadow)">
          <path className="memory-back" d="M111 461h72l12 12h151a10 10 0 0 1 10 10v142a10 10 0 0 1-10 10H111a10 10 0 0 1-10-10V471a10 10 0 0 1 10-10Z" />
          <path className="memory-front" d="M101 483a10 10 0 0 1 10-10h245a10 10 0 0 1 10 10v141a10 10 0 0 1-10 10H111a10 10 0 0 1-10-10Z" />
          <text className="card-label" x="123" y="509">PROJECT MEMORY</text>
          <text className="card-subtitle" x="123" y="524">REVIEWED KNOWLEDGE</text>
          <path className="memory-rule" d="M123 536h211" />
          <g className="saved-lesson">
            <rect className="saved-wash" x="118" y="546" width="221" height="49" rx="5" />
            <text className="saved-name" x="131" y="562">Resume after reconnects</text>
            <text className="saved-detail" x="131" y="576">Replay completed results</text>
            <path className="saved-check" d="m312 561 4 4 8-9" />
          </g>
          <text className="memory-foot" x="123" y="615">KEPT FOR FUTURE WORK</text>
        </g>

        <g className="moving-lesson" transform="translate(220 397)">
          <animateMotion dur="4.8s" repeatCount="indefinite" path="M220 397 C220 430 220 486 220 570" keyPoints="0;0;1;1" keyTimes="0;.2;.72;1" calcMode="linear" />
          <animate attributeName="opacity" dur="4.8s" repeatCount="indefinite" values="0;0;1;1;0" keyTimes="0;.18;.22;.66;.78" />
          <rect className="moving-paper" x="-43" y="-15" width="86" height="30" rx="5" />
          <text className="moving-paper-title" x="-34" y="1">LESSON REVIEW</text>
          <circle className="moving-paper-dot" cx="32" cy="0" r="3" />
        </g>
      </svg>
    </main>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<MemoryAnimation />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
