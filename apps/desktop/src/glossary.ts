/**
 * ModelFit's vocabulary — the shared source of truth for every definition the
 * product publishes.
 *
 * Two consumers: <Term id="..."> renders an entry as a hover card in the app,
 * and scripts/build-glossary-page.py renders all of them as /glossary/ on the
 * website. Not every entry has a hover card — terms the UI never surfaces still
 * belong here so the page and the posts can link to one canonical definition
 * instead of drifting copies.
 *
 * `anchor` is a section id in one of the posts on modelfit.docgraph.app. Those
 * ids are a published contract between this app and the website: shipped builds
 * keep linking to them forever, so an anchor may be added but never renamed.
 * Both posts carry a comment saying so, and
 * scripts/check-glossary-anchors.py fails the build if one stops resolving.
 * Adding a term here is all it takes to make it explainable — <Term id="...">
 * does the rest.
 *
 * `brief` is bundled rather than fetched: ModelFit answers offline, and the
 * post is only the optional "more" layer.
 */

const SITE = "https://modelfit.docgraph.app";

/** Posts a term can point into. Keys are stable; paths are the contract. */
export const POSTS = {
  fundamentals: `${SITE}/blog/local-llm-fundamentals/`,
  runtimes: `${SITE}/blog/local-ai-runtimes/`,
} as const;

export type PostId = keyof typeof POSTS;

export type GlossaryEntry = {
  /** Heading shown at the top of the hover card. */
  title: string;
  /** One or two sentences. Enough to unblock, not enough to need scrolling. */
  brief: string;
  /** Section id in the post, without the "#". */
  anchor: string;
  /** Which post the anchor lives in. Defaults to the fundamentals post. */
  post?: PostId;
  /**
   * Extra strings the website glossary search should match — the shorthand and
   * jargon people actually type ("tok/s", "Q4_K_M", "TTFT") when it does not
   * appear in the title or the brief. Unused by the app's hover cards.
   */
  aliases?: readonly string[];
};

export const GLOSSARY = {
  quantization: {
    title: "Quantization",
    brief:
      "How many bits each parameter is stored in. Q4_K_M is 4-bit and about a quarter the size of the original with very little quality lost — which is why it's the usual pick.",
    anchor: "quantization",
    aliases: ["Q4_K_M", "Q5_K_M", "Q8_0", "quant", "GGUF quant", "4-bit"],
  },
  memory: {
    title: "Memory needed",
    brief:
      "The model's weights, plus the KV cache for your chosen context length, plus about a gigabyte of runtime overhead. All of it has to stay resident while the model is loaded.",
    anchor: "memory-math",
    aliases: ["RAM", "footprint", "how much memory"],
  },
  context: {
    title: "Context length",
    brief:
      "How much conversation the model holds at once, in tokens — roughly 0.75 words each. Longer context costs memory, so pick the smallest that suits your work.",
    anchor: "context-length",
    aliases: ["context window", "ctx", "token limit"],
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
    aliases: ["GB/s", "memory speed"],
  },
  tokensPerSecond: {
    title: "Tokens per second",
    brief:
      "Generation speed, in word-fragments per second. Around 10 keeps pace with reading; 30 or more feels immediate and is what coding and agent work want.",
    anchor: "tokens-per-second",
    aliases: ["tok/s", "t/s", "tps", "throughput", "generation speed"],
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
    anchor: "score",
  },
  runtime: {
    title: "Runtime",
    brief:
      "The layer that manages running a model: downloading weights, choosing settings, and serving an API. Ollama is one, wrapped around an inference engine that does the actual maths.",
    anchor: "llm-runtime",
    post: "runtimes",
  },
  backend: {
    title: "Acceleration backend",
    brief:
      "The hardware path the inference engine computes on — Metal on Apple Silicon, CUDA on NVIDIA, ROCm or Vulkan on AMD, plain CPU otherwise. It decides which engines can run here at all.",
    anchor: "inference-engine",
    post: "runtimes",
  },
  parameters: {
    title: "Parameters",
    brief:
      "The learned numbers a model is made of — the 8 in \"Llama 8B\" means eight billion. They set both the memory bill and the speed ceiling, because every one is read again for every token.",
    anchor: "parameters",
  },
  kvCache: {
    title: "KV cache",
    brief:
      "Working memory for the conversation so far, so the model doesn't recompute it for each new token. It grows with context length and comes out of the same budget as the weights.",
    anchor: "kv-cache",
  },
  offloading: {
    title: "Offloading",
    brief:
      "Splitting a model between GPU and system memory when it won't fit in the fast one. It runs, but every layer left behind drags the whole generation onto the slower path.",
    anchor: "offloading",
  },
  gguf: {
    title: "GGUF",
    brief:
      "The file format most local models ship in — weights, quantization, tokenizer and metadata in a single file. A tool that reads GGUF will generally read any GGUF.",
    anchor: "gguf",
  },
  mixtureOfExperts: {
    title: "Mixture of experts",
    brief:
      "An architecture that holds many parameters but activates only a fraction of them per token — so it costs the memory of a large model and runs nearer the speed of a small one.",
    anchor: "mixture-of-experts",
    aliases: ["MoE", "sparse", "active parameters"],
  },
  inference: {
    title: "Inference",
    brief:
      "Running a trained model forward: input in, output out. Not a piece of software — it's the process every engine and runtime exists to carry out.",
    anchor: "inference",
    post: "runtimes",
  },
  prefillDecode: {
    title: "Prefill and decode",
    brief:
      "The two phases of an answer. Prefill reads your prompt in parallel and sets the wait before the first word; decode writes the reply one token at a time and sets tokens per second.",
    anchor: "prefill-decode",
    post: "runtimes",
    aliases: ["TTFT", "time to first token", "prompt processing"],
  },
  inferenceEngine: {
    title: "Inference engine",
    brief:
      "The software that does the actual maths — kernels, hardware backends, quantized arithmetic, memory layout. llama.cpp and MLX are engines; Ollama is a runtime built over one.",
    anchor: "inference-engine",
    post: "runtimes",
    aliases: ["GGML", "backend", "kernels"],
  },
  servingEngine: {
    title: "Serving engine",
    brief:
      "A runtime tuned for many simultaneous users rather than one. vLLM and SGLang are the common ones, and the tricks they use only pay off under real concurrency.",
    anchor: "serving-engine",
    post: "runtimes",
  },
  pagedAttention: {
    title: "Paged attention",
    brief:
      "Handing out KV cache in small blocks as a conversation actually grows, instead of reserving the maximum up front. It's how a serving engine fits far more sessions on one card.",
    anchor: "serving-engine",
    post: "runtimes",
  },
  continuousBatching: {
    title: "Continuous batching",
    brief:
      "Slotting new requests into a running batch as older ones finish, rather than waiting for the whole batch to drain. Keeps a busy GPU from idling between requests.",
    anchor: "serving-engine",
    post: "runtimes",
  },
  runtimeManager: {
    title: "Runtime manager",
    brief:
      "The layer above a runtime: it reads the hardware, works out which models and backends suit it, and configures the rest. It's the category ModelFit is in.",
    anchor: "runtime-manager",
    post: "runtimes",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type TermId = keyof typeof GLOSSARY;

/** The term's entry on the website glossary page. */
export function glossaryUrl(id: TermId): string {
  return `${SITE}/glossary/#${id.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;
}

/** Deep link to the section of the post that explains `id`. */
export function termUrl(id: TermId): string {
  const entry: GlossaryEntry = GLOSSARY[id];
  return `${POSTS[entry.post ?? "fundamentals"]}#${entry.anchor}`;
}
