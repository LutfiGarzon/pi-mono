# llama.cpp

Pi supports the [llama.cpp](https://github.com/ggml-org/llama.cpp) router server. The router discovers multiple GGUF models and loads or unloads them on demand.

Use a current llama.cpp build with router support. Follow the [build instructions](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) or install a [prebuilt release](https://github.com/ggml-org/llama.cpp/releases) for your platform.

## Start the router

Start `llama-server` without `--model` or `-m`. Passing a model starts single-model mode instead of router mode.

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 99 \
  -c 32768 \
  -fa on \
  --cache-type-k q8_0 \
  --cache-type-v q8_0
```

Important options:

- `--models-dir ~/models` discovers local GGUF files.
- `--no-models-autoload` keeps loading explicit through `/llama`.
- `--jinja` enables compatible chat templates and tool calling.
- `-ngl 99` offloads as many layers as possible to the GPU. On Apple Silicon this offloads to the Metal GPU; on NVIDIA/AMD it targets CUDA/ROCm.
- `-c 32768` sets the context window for each loaded model. Omit it to use the model's native context, which may require substantially more memory.
- `-fa` enables flash attention. Reduces memory usage at long context lengths. Available on CUDA, Metal, and ROCm.
- `--cache-type-k q8_0 --cache-type-v q8_0` quantizes the KV cache to 8-bit. Saves significant VRAM with negligible quality loss, allowing larger effective context windows.

A single-file model can sit directly in the model directory. Put multimodal and multi-shard models in separate subdirectories:

```text
~/models/
├── llama-3.2-1b-Q4_K_M.gguf
├── gemma-3-4b-it-Q4_K_M/
│   ├── gemma-3-4b-it-Q4_K_M.gguf
│   └── mmproj-F16.gguf
└── large-model-Q4_K_M/
    ├── large-model-Q4_K_M-00001-of-00003.gguf
    ├── large-model-Q4_K_M-00002-of-00003.gguf
    └── large-model-Q4_K_M-00003-of-00003.gguf
```

Restart the router after manually adding files. For per-model context sizes and other options, use [llama.cpp model presets](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets).

## Performance tuning

Several flags can substantially improve throughput on local hardware. These apply both to router mode (global flags) and single-model mode.

### Speculative decoding with MTP

Models with Multi-Token Prediction heads (Ornith, Qwen3, some Llama 4 variants) can use built-in self-speculation with no separate draft model. The MTP weights are part of the GGUF and llama.cpp picks them up automatically:

```bash
llama-server \
  -m model.gguf \
  --spec-type draft-mtp \
  --spec-draft-n-max 3 \
  ...
```

- `--spec-type draft-mtp` enables MTP-based speculative decoding.
- `--spec-draft-n-max 3` controls how many tokens to draft per step. Typical range is 1-8; start with 3.

MTP typically gives a **1.5-2x throughput increase** without quality loss. It works on all GPU backends including Metal (Apple Silicon).

To check if a model has MTP heads, look for `mtp` layers in its GGUF metadata:

```bash
llama-gguf-dump model.gguf | grep mtp
```

### KV cache quantization

Quantizing the key-value cache saves VRAM at minimal quality cost:

```bash
--cache-type-k q8_0 --cache-type-v q8_0
```

`q8_0` (8-bit) is the recommended starting point. For maximum memory savings try `q4_0` (4-bit), though it may impact quality on some models. This is especially important on machines with limited unified memory (16-24 GB Apple Silicon, 12 GB NVIDIA GPUs).

### Flash attention

```bash
-fa on
```

Reduces the memory footprint of the attention computation from O(n^2) to O(n). Essential for long context windows (32K+). Supported on CUDA, Metal (Apple Silicon), and ROCm.

### Apple Silicon notes

On MacBook Pro with M-series chips:

- **Unified memory is shared between GPU and CPU.** The GPU can access all system RAM. A 16 GB M1 Pro can run 9B-parameter Q4_K_M models entirely on GPU with room for KV cache.
- **Metal flash attention (`-fa`) works** on M1 and newer.
- **MTP speculative decoding works** on Metal. No CUDA requirement.
- **`-ngl 99` offloads to the Metal GPU.** Use `-ngl 99` not `-ngl 999`; the extra digit is harmless but unnecessary.
- **Lower context if VRAM is tight.** On 16 GB unified memory with a 9B Q4_K_M model (~5.5 GB), a 245K context with KV cache quantization is possible. Without quantization, start at 32K and increase.
- **Monitor memory pressure** with Activity Monitor. If the system enters compressed/swapped memory, lower `-c` or add `--cache-type-k q4_0 --cache-type-v q4_0`.

### Single-model mode for maximum performance

Router mode adds a small management overhead. If you run one model exclusively, single-model mode is simpler and marginally faster:

```bash
llama-server \
  -m ~/models/Ornith-1.0-9B-MTP-Q4_K_M.gguf \
  --spec-type draft-mtp \
  --spec-draft-n-max 3 \
  -ngl 99 \
  -c 245000 \
  -fa on \
  --jinja \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --host 127.0.0.1 \
  --port 8080
```

Single-model mode still exposes the same `/v1` inference API and Pi connects identically. The trade-off is that `/llama` model management commands are unavailable; restart the server to switch models.

### Model presets for per-model configuration

In router mode, use model presets to apply MTP and context sizes per model instead of globally. Create a JSON preset file:

```json
{
  "ornith-1.0-9b": {
    "speculative": {
      "type": "draft-mtp",
      "draft-max": 3
    },
    "cache_type_k": "q8_0",
    "cache_type_v": "q8_0",
    "n_ctx": 245000
  },
  "qwen3-8b": {
    "speculative": {
      "type": "draft-mtp",
      "draft-max": 2
    },
    "n_ctx": 32768
  }
}
```

Then start the router with `--models-presets-file presets.json`. See the [llama.cpp model presets documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets) for the full schema.

## Configure Pi

Start Pi and configure the provider:

```text
/login llama.cpp
```

Enter the router URL and optional API key. The default URL is `http://127.0.0.1:8080`.

Environment variables can configure the same values without `/login`:

```bash
export LLAMA_BASE_URL=http://127.0.0.1:8080
export LLAMA_API_KEY=optional-secret
pi
```

If the server uses an API key, start `llama-server` with the matching `--api-key` value. Keep `--host 127.0.0.1` for local-only access.

## Manage models

Run:

```text
/llama
```

- Select an unloaded model to load it.
- Select a loaded model to unload it.
- Select **Download model…**, search Hugging Face, then choose a repository and quantization. Exact `owner/repository[:quant]` values also work.
- Press Escape during a load or download to confirm cancellation.

Hugging Face search uses `HF_TOKEN` when set, then checks `$HF_TOKEN_PATH`, `$HF_HOME/token`, `$XDG_CACHE_HOME/huggingface/token`, and `~/.cache/huggingface/token`. Search also works without authentication, subject to lower rate limits. Pi warns before downloading gated repositories and links to their access page. The llama.cpp server performs the download, so its process must also have `HF_TOKEN` when the selected repository requires access.

If other models are loaded, Pi asks whether to unload them first or keep them loaded. Pi does not silently unload models and never deletes model files. The router may be shared with other clients, so `/llama` always displays the router's current state.

Only loaded models appear in `/model`. After loading a model, run `/model` to select it for the current Pi session.

If the router disconnects, `/llama` shows **Retry** and **Close**. Retry reconnects and refreshes model state without replaying the interrupted operation.

## Troubleshooting

Check that the router is reachable:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

- **No models in `/llama`:** Check `--models-dir`, the directory layout, and restart the router.
- **Model missing from `/model`:** Load it with `/llama` first.
- **Load fails or uses too much memory:** Lower `-c` or unload another model.
- **Server is not in router mode:** Start it without `--model`, `-m`, or `-hf`.
