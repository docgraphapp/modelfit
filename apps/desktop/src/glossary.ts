/**
 * Terms the UI explains on hover.
 *
 * `anchor` is a section id in the "Local LLM fundamentals" post on
 * modelfit.docgraph.app. Those ids are a published contract between this app
 * and the website: shipped builds keep linking to them forever, so an anchor
 * may be added but never renamed. Adding a term here is all it takes to make
 * it explainable — <Term id="..."> does the rest.
 *
 * `brief` is bundled rather than fetched: ModelFit answers offline, and the
 * post is only the optional "more" layer.
 */

const POST = "https://modelfit.docgraph.app/blog/local-llm-fundamentals/";

export type GlossaryEntry = {
  /** Heading shown at the top of the hover card. */
  title: string;
  /** One or two sentences. Enough to unblock, not enough to need scrolling. */
  brief: string;
  /** Section id in the post, without the "#". */
  anchor: string;
};

export const GLOSSARY = {
  quantization: {
    title: "Quantization",
    brief:
      "How many bits each parameter is stored in. Q4_K_M is 4-bit and about a quarter the size of the original with very little quality lost — which is why it's the usual pick.",
    anchor: "quantization",
  },
  memory: {
    title: "Memory needed",
    brief:
      "The model's weights, plus the KV cache for your chosen context length, plus about a gigabyte of runtime overhead. All of it has to stay resident while the model is loaded.",
    anchor: "memory-math",
  },
  context: {
    title: "Context length",
    brief:
      "How much conversation the model holds at once, in tokens — roughly 0.75 words each. Longer context costs memory, so pick the smallest that suits your work.",
    anchor: "context-length",
  },
  unifiedMemory: {
    title: "Unified memory",
    brief:
      "On Apple Silicon the CPU and GPU share one pool at full speed, so the whole machine's RAM is available to a model — minus what macOS and your other apps are using.",
    anchor: "unified-memory",
  },
  vram: {
    title: "VRAM",
    brief:
      "Memory on the graphics card itself. On a machine with a discrete GPU this is the budget that matters — system RAM sits behind a much slower bus and can't substitute for it.",
    anchor: "unified-memory",
  },
  bandwidth: {
    title: "Memory bandwidth",
    brief:
      "How fast your machine can read from memory. Generating text means reading the whole model for every token, so bandwidth — not GPU compute — sets the speed ceiling.",
    anchor: "bandwidth",
  },
  tokensPerSecond: {
    title: "Tokens per second",
    brief:
      "Generation speed, in word-fragments per second. Around 10 keeps pace with reading; 30 or more feels immediate and is what coding and agent work want.",
    anchor: "tokens-per-second",
  },
  measured: {
    title: "Measured vs estimated",
    brief:
      "Estimates come from your chip's rated bandwidth, which is a ceiling no machine quite reaches. A short real benchmark replaces it with what your machine actually does.",
    anchor: "benchmark",
  },
  benchmark: {
    title: "Benchmarking",
    brief:
      "Runs a short generation on a small installed model and measures the throughput, then rescales every prediction to your machine's real effective bandwidth. Takes about a minute.",
    anchor: "benchmark",
  },
  fit: {
    title: "Fit verdict",
    brief:
      "Whether the model fits alongside everything else you're running. Comfortable means room to grow; tight means a long conversation could push it over; too big means it won't fit in fast memory.",
    anchor: "fit-verdict",
  },
  score: {
    title: "Score",
    brief:
      "Quality and speed combined into one 0–100 number, weighted for the objective you picked. It's for ranking models against each other on this machine, not an absolute rating.",
    anchor: "choosing",
  },
  runtime: {
    title: "Runtime",
    brief:
      "The program that actually loads the weights and does the maths. Ollama wraps llama.cpp with a background service and a one-command model library.",
    anchor: "runtime",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type TermId = keyof typeof GLOSSARY;

/** Deep link to the section of the post that explains `id`. */
export function termUrl(id: TermId): string {
  return `${POST}#${GLOSSARY[id].anchor}`;
}
