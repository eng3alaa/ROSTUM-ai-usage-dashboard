// Plan 11 T4a-1 - independent resolution expectations; no browser, network or dependencies.
// Relayed by checks/89h-price-resolution.mjs; alone: node tests/tools/price-resolution.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
// Hand-written from the price spec, not generated from rows or resolver output.
// Tuple: [id, expected label, input, output, platform?, source? (default = 'default'), cw?, cr?].
const CASES = [
  // Anthropic: canonical, dated, Cursor, Bedrock and Vertex spellings.
  ['claude-fable-5-1', 'Claude Fable/Mythos 5.1', 10, 50],
  ['claude-mythos-5-1', 'Claude Fable/Mythos 5.1', 10, 50],
  ['claude-fable-5', 'Claude Fable/Mythos 5', 10, 50],
  ['claude-opus-5-5', 'Claude Opus 5.5', 4, 20],
  ['claude-opus-5', 'Claude Opus 5 / 4.5+', 5, 25],
  ['claude-opus-4-5', 'Claude Opus 5 / 4.5+', 5, 25],
  ['claude-opus-4', 'Claude Opus 4 / 4.1', 15, 75],
  ['claude-opus-4-1', 'Claude Opus 4 / 4.1', 15, 75],
  ['claude-opus-4-0', 'Claude Opus 4 / 4.1', 15, 75, undefined, 'default', 18.75, 1.5],
  ['claude-opus-4-0-20250514', 'Claude Opus 4 / 4.1', 15, 75],
  ['Claude-Opus-4.0', 'Claude Opus 4 / 4.1', 15, 75],
  ['claude-4.1-opus-thinking', 'Claude Opus 4 / 4.1', 15, 75],
  ['us.anthropic.claude-opus-4-0-20250514-v1:0', 'Claude Opus 4 / 4.1', 15, 75],
  ['claude-opus-4-0@20250514', 'Claude Opus 4 / 4.1', 15, 75],
  ['eu.anthropic.claude-opus-4-1-20250805-v1:0', 'Claude Opus 4 / 4.1', 15, 75],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 2, 10],
  ['claude-sonnet-5', 'Claude Sonnet 5', 2, 10],
  ['claude-sonnet-4-20250514', 'Claude Sonnet 4.x / 3.x', 3, 15],
  ['claude-3.5-sonnet', 'Claude Sonnet 4.x / 3.x', 3, 15],
  ['apac.anthropic.claude-3-7-sonnet-20250219-v1:0', 'Claude Sonnet 4.x / 3.x', 3, 15],
  ['claude-haiku-5-5', 'Claude Haiku 5.5', 0.1, 0.5],
  ['claude-haiku-4-5', 'Claude Haiku 4.5', 1, 5],
  ['claude-3-5-haiku-20241022', 'Claude Haiku 3.5', 0.8, 4],
  ['claude-3-haiku-20240307', 'Claude Haiku 3', 0.25, 1.25],
  // OpenAI.
  ['gpt-5.6-sol', 'GPT-5.6 Sol', 4, 20],
  ['gpt-5.5', 'GPT-5.5', 5, 30],
  ['gpt-5.5-pro', 'GPT-5.5 Pro', 30, 180],
  ['gpt-5.6-terra', 'GPT-5.6 Terra', 2, 12],
  ['gpt-5.6-luna', 'GPT-5.6 Luna', 0.2, 1.2],
  ['gpt-5.4-pro', 'GPT-5.4 Pro', 30, 180],
  ['gpt-5.4-mini', 'GPT-5.4 mini', 0.75, 4.5],
  ['gpt-5.4-nano', 'GPT-5.4 nano', 0.2, 1.25],
  ['gpt-5.4', 'GPT-5.4', 2.5, 15],
  ['gpt-5-mini', 'GPT-5 mini', 0.25, 2],
  ['gpt-5-nano', 'GPT-5 nano', 0.05, 0.4],
  ['gpt-5-codex', 'GPT-5-Codex', 1.25, 10],
  ['codex-mini-latest', 'codex-mini-latest', 1.5, 6],
  ['gpt-5.3-codex', 'GPT-5.3-Codex', 1.75, 14],
  ['gpt-4.1-2025-04-14', 'GPT-4.1', 2, 8],
  ['gpt-4.1-mini-2025-04-14', 'GPT-4.1 mini', 0.4, 1.6],
  ['gpt-4.1-nano-2025-04-14', 'GPT-4.1 nano', 0.1, 0.4],
  ['gpt-4-turbo-2024-04-09', 'GPT-4 Turbo', 10, 30],
  ['gpt-4-0613', 'GPT-4', 30, 60],
  ['gpt-3.5-turbo-0125', 'GPT-3.5 Turbo', 0.5, 1.5],
  ['gpt-3.5-turbo-1106', 'GPT-3.5 Turbo 1106', 1, 2],
  ['gpt-3.5-turbo-instruct', 'GPT-3.5 Turbo Instruct', 1.5, 2],
  ['o4-mini-2025-04-16', 'o4-mini', 1.1, 4.4],
  ['o3-2025-04-16', 'o3', 2, 8],
  ['o1-preview-2024-09-12', 'o1', 15, 60],
  ['o1-mini-2024-09-12', 'o1-mini', 1.1, 4.4],
  ['GPT-4o-mini', 'GPT-4o mini', 0.15, 0.6],
  ['chatgpt-4o-latest', 'GPT-4o', 2.5, 10],
  ['o3-pro', 'o3-pro', 20, 80],
  ['o3-mini', 'o3-mini', 1.1, 4.4],
  ['o1-pro', 'o1-pro', 150, 600],
  ['auto', 'ChatGPT / Copilot (auto)', 2, 12],
  // Google: keep Flash, Flash-Lite and older suffix families distinct.
  ['gemini-3.6-flash', 'Gemini 3.6/3.7/3.8 Flash', 0.75, 3.75],
  ['gemini-3.7-flash', 'Gemini 3.6/3.7/3.8 Flash', 0.75, 3.75],
  ['gemini-3.8-flash', 'Gemini 3.6/3.7/3.8 Flash', 0.75, 3.75],
  ['gemini-3.6-flash-lite', 'Gemini 3.x Flash-Lite', 0.25, 1.5, undefined, 'default', 0, 0.025],
  ['gemini-3.7-flash-lite', 'Gemini 3.x Flash-Lite', 0.25, 1.5, undefined, 'default', 0, 0.025],
  ['gemini-3.8-flash-lite', 'Gemini 3.x Flash-Lite', 0.25, 1.5, undefined, 'default', 0, 0.025],
  ['gemini-3.6-flash-lite-preview', 'Gemini 3.x Flash-Lite', 0.25, 1.5],
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 0.3, 2.5],
  ['gemini-3.5-flash', 'Gemini 3.5 Flash', 1.5, 9],
  ['gemini-3-pro-preview', 'Gemini 3.x Pro', 2, 12],
  ['gemini-3-flash-lite', 'Gemini 3.x Flash-Lite', 0.25, 1.5],
  ['gemini-2.5-pro', 'Gemini 2.5 Pro', 1.25, 10],
  ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 0.1, 0.4],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash', 0.3, 2.5],
  ['gemini-2.0-flash-001', 'Gemini 2.0 Flash', 0.1, 0.4],
  ['gemini-2.0-flash-lite-001', 'Gemini 2.0 Flash-Lite', 0.075, 0.3],
  ['gemini-1.5-pro-002', 'Gemini 1.5 Pro', 1.25, 5],
  ['gemini-1.5-flash-002', 'Gemini 1.5 Flash', 0.075, 0.3],
  ['gemini-1.5-flash-8b-001', 'Gemini 1.5 Flash-8B', 0.0375, 0.15],
  ['gemma-3-27b-it', 'Gemma 3 / 3n on Gemini API', 0, 0],
  // Hosted model ids: provider prefixes are part of the identity.
  ['openai/gpt-oss-120b', 'gpt-oss-120b (Groq default; Together/Fireworks same price)', 0.15, 0.6],
  ['openai/gpt-oss-20b', 'gpt-oss-20b (Groq default)', 0.075, 0.3],
  ['openai/gpt-oss-safeguard-20b', 'gpt-oss-safeguard-20b', 0.075, 0.3],
  ['qwen/qwen3.8-27b', 'Qwen 3.8 27B', 0.8, 4],
  ['meta-llama/llama-prompt-guard-2-22m', 'Llama Prompt Guard 2', 0.03, 0.03],
  ['llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile (Groq) (last known)', 0.59, 0.79],
  ['llama-3.1-8b-instant', 'Llama 3.1 8B Instant (Groq) (last known)', 0.05, 0.08],
  ['moonshotai/kimi-k2-instruct-0905', 'Kimi K2 Instruct (Groq) (last known)', 1, 3],
  ['deepseek-r1-distill-llama-70b', 'DeepSeek R1 Distill Llama 70B (Groq) (last known)', 0.75, 0.99],
  ['meta-llama/llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick (Groq)', 0.2, 0.6],
  ['meta-llama/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout (Groq default)', 0.11, 0.34],
  ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Llama 3.3 70B Instruct Turbo (Together default)', 1.04, 1.04],
  ['meta-llama/Meta-Llama-3-8B-Instruct-Lite', 'Llama 3 8B Instruct Lite', 0.14, 0.14],
  ['Qwen/Qwen2.5-7B-Instruct-Turbo', 'Qwen2.5 7B Instruct Turbo', 0.3, 0.3],
  ['Qwen/Qwen3-235B-A22B-Instruct-2507-tput', 'Qwen3 235B A22B Instruct 2507 FP8 Throughput', 0.2, 0.6],
  ['moonshotai/Kimi-K3', 'Kimi K3 (Together default)', 3, 15],
  ['deepseek-ai/DeepSeek-V4-Pro-0813', 'DeepSeek V4 Pro 0813 (Together default)', 1.32, 3.96],
  ['deepseek-ai/DeepSeek-V4.1-Flash', 'DeepSeek V4.1 Flash (Together)', 0.3, 1.2],
  ['zai-org/GLM-5.3', 'GLM-5.3 / GLM-5.2 (Together)', 1.4, 4.4],
  ['zai-org/GLM-5.3-Flash', 'GLM-5.3 Flash (Together)', 0.15, 0.5],
  ['MiniMaxAI/MiniMax-M3', 'MiniMax M3 (Together)', 0.3, 1.2],
  ['Qwen/Qwen3.8-2.4T-A95B', 'Qwen3.8-2.4T-A95B (Together)', 2, 6],
  ['Qwen/Qwen3.7-Max', 'Qwen3.7-Max (Together)', 2.5, 7.5],
  ['Qwen/Qwen3.7-Plus', 'Qwen3.7-Plus (Together)', 0.32, 1.28],
  ['Qwen/Qwen3.6-Plus', 'Qwen3.6-Plus (Together)', 0.5, 3],
  ['Qwen/Qwen3.8-Flash', 'Qwen3.8-Flash (Together)', 0.15, 0.47],
  ['Qwen/Qwen3.5-9B', 'Qwen3.5-9B (Together)', 0.17, 0.25],
  ['Qwen/Qwen3.5-397B-A17B', 'Qwen3.5-397B-A17B (Together)', 0.6, 3.6],
  ['meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', 'Llama 4 Maverick (Together, no longer serverless)', 0.27, 0.85],
  ['meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'Llama 3.1 70B Instruct Turbo (Together) (last known)', 0.88, 0.88],
  ['meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', 'Llama 3.1 405B Instruct Turbo (Together) (last known)', 3.5, 3.5],
  ['accounts/fireworks/models/gpt-oss-120b', 'gpt-oss-120b (Fireworks)', 0.15, 0.6],
  ['accounts/fireworks/models/kimi-k3', 'Kimi K3 (Fireworks)', 3, 15],
  ['accounts/fireworks/models/deepseek-v4p1-flash', 'DeepSeek V4.1 Flash (Fireworks)', 0.3, 1.2],
  ['accounts/fireworks/models/glm-5p3', 'GLM 5.3 (Fireworks)', 1.4, 4.4],
  ['accounts/fireworks/models/glm-5p3-flash', 'GLM 5.3 Flash (Fireworks)', 0.15, 0.5],
  ['accounts/fireworks/models/qwen3p8-max', 'Qwen 3.8 Max (Fireworks)', 2, 6],
  ['accounts/fireworks/models/minimax-m3', 'MiniMax M3 (Fireworks)', 0.3, 1.2],
  ['accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b', 'Nemotron 3.5 Lightning 30B A3B (Fireworks)', 0.05, 0.2],
  ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'Fireworks size-tier fallback (dense >16B)', 0.9, 0.9],
  ['accounts/fireworks/models/llama-v3p1-8b-instruct', 'Llama 3.1 8B (Fireworks, size tier 4-16B)', 0.2, 0.2],
  ['accounts/fireworks/models/llama4-scout-instruct-basic', 'Llama 4 Scout (Fireworks) (last known)', 0.15, 0.6],
  ['accounts/fireworks/models/llama4-maverick-instruct-basic', 'Llama 4 Maverick (Fireworks) (last known)', 0.22, 0.88],
  ['accounts/fireworks/models/gpt-oss-20b', 'gpt-oss-20b (Fireworks) (last known)', 0.07, 0.3],
  ['meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Llama 3.1 8B Instruct Turbo (DeepInfra default)', 0.02, 0.04],
  ['deepseek-ai/DeepSeek-R1-0528', 'DeepSeek-R1 / R1-0528 (DeepInfra default)', 0.5, 2.15],
  ['deepseek-ai/DeepSeek-V3', 'DeepSeek-V3 (DeepInfra default)', 0.32, 0.89],
  ['deepseek-ai/DeepSeek-V3.1', 'DeepSeek-V3.1 (DeepInfra)', 0.25, 0.95],
  ['deepseek-ai/DeepSeek-V3.2', 'DeepSeek-V3.2 (DeepInfra)', 0.26, 0.38],
  ['Qwen/Qwen3-32B', 'Qwen3-32B (DeepInfra default)', 0.08, 0.28],
  ['Qwen/Qwen3-235B-A22B-Instruct-2507', 'Qwen3-235B-A22B-Instruct-2507 (DeepInfra)', 0.09, 0.55],
  ['moonshotai/Kimi-K2.6', 'Kimi-K2.6 (DeepInfra)', 0.75, 3.5],
  ['google/gemma-4-31B-it', 'Gemma 4 (DeepInfra)', 0.2, 0.4],
  ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.3-70B-Instruct (SambaNova)', 0.6, 1.2],
  ['gpt-oss-120b', 'gpt-oss-120b (SambaNova default; bare id)', 0.22, 0.59],
  ['gemma-4-31B-it', 'gemma-4-31B-it (SambaNova)', 0.38, 1.15],
  ['Meta-Llama-3.1-8B-Instruct', 'Meta-Llama-3.1-8B-Instruct (SambaNova) (last known)', 0.1, 0.2],
  ['Meta-Llama-3.1-405B-Instruct', 'Meta-Llama-3.1-405B-Instruct (SambaNova) (last known)', 5, 10],
  ['Llama-4-Maverick-17B-128E-Instruct', 'Llama-4-Maverick-17B-128E-Instruct (SambaNova) (last known)', 0.63, 1.8],
  ['llama3.1-8b', 'llama3.1-8b (Cerebras) (last known)', 0.1, 0.1],
  ['llama-3.3-70b', 'llama-3.3-70b (Cerebras) (last known)', 0.85, 1.2],
  ['qwen-3-32b', 'qwen-3-32b (Cerebras) (last known)', 0.4, 0.8],
  ['qwen-3-235b-a22b-instruct-2507', 'qwen-3-235b-a22b-instruct-2507 (Cerebras) (last known)', 0.6, 1.2],
  ['llama-4-scout-17b-16e-instruct', 'llama-4-scout-17b-16e-instruct (Cerebras) (last known)', 0.65, 0.85],
  // xAI and existing DeepSeek vendor rows.
  ['grok-4.7-latest', 'Grok 4.7', 2, 6],
  ['grok-4.6', 'Grok 4.6', 2, 6],
  ['grok-4.5', 'Grok 4.5', 2, 6],
  ['grok-4.3', 'Grok 4.3', 1.25, 2.5],
  ['grok-4.20-0309-reasoning', 'Grok 4.20 (reasoning / non-reasoning / multi-agent)', 1.25, 2.5],
  ['grok-code-fast-1-0825', 'Grok Build 0.1 (= grok-code-fast-1)', 1, 2],
  ['grok-4', 'Grok 4.3', 1.25, 2.5],
  ['grok-4-fast-reasoning', 'Grok 4.3', 1.25, 2.5],
  ['grok-4-1-fast-non-reasoning', 'Grok 4.3', 1.25, 2.5],
  ['grok-3-fast-beta', 'Grok 4.3', 1.25, 2.5],
  ['grok-3-mini-fast-beta', 'Grok 3 Mini', 0.3, 0.5],
  ['grok-2-vision-latest', 'Grok 2', 2, 10],
  ['grok', 'Grok 4 (xAI list)', 3, 15],
  ['deepseek-reasoner', 'DeepSeek Reasoner', 0.55, 2.19],
  ['deepseek-chat', 'DeepSeek chat (V3 list)', 0.27, 1.1],
  // Perplexity and Meta consumer.
  ['sonar', 'Sonar', 1, 1],
  ['sonar-pro', 'Sonar Pro', 3, 15],
  ['sonar-reasoning-pro', 'Sonar Reasoning Pro', 2, 8],
  ['sonar-reasoning', 'Sonar Reasoning Pro', 2, 8],
  ['sonar-deep-research', 'Sonar Deep Research', 2, 8],
  ['perplexity', 'Perplexity Sonar', 1, 1],
  ['meta-ai', 'Meta AI (consumer, no API price)', 0, 0],
  // Mistral: sizes, snapshots, bare ids and retired aliases.
  ['mistral-large-4-0', 'Mistral Large 4 (public preview, sale price)', 0.68, 2.09],
  ['mistral-large-2512', 'Mistral Large 3', 0.5, 1.5],
  ['mistral-large-2411', 'Mistral Large 3', 0.5, 1.5],
  ['mistral-medium-2604', 'Mistral Medium 3.5', 1.5, 7.5],
  ['mistral-small-2603', 'Mistral Small 4', 0.15, 0.6],
  ['ministral-14b-2512', 'Ministral 3 14B', 0.2, 0.2, undefined, 'default', 0, 0.02],
  ['ministral-14b-latest', 'Ministral 3 14B', 0.2, 0.2, undefined, 'default', 0, 0.02],
  ['ministral-14b', 'Ministral 3 14B', 0.2, 0.2, undefined, 'default', 0, 0.02],
  ['ministral-8b-2512', 'Ministral 3 8B', 0.15, 0.15, undefined, 'default', 0, 0.015],
  ['ministral-8b-latest', 'Ministral 3 8B', 0.15, 0.15, undefined, 'default', 0, 0.015],
  ['ministral-8b', 'Ministral 3 8B', 0.15, 0.15, undefined, 'default', 0, 0.015],
  ['ministral-8b-2410', 'Ministral 3 8B', 0.15, 0.15, undefined, 'default', 0, 0.015],
  ['ministral-3b-2512', 'Ministral 3 3B', 0.1, 0.1, undefined, 'default', 0, 0.01],
  ['ministral-3b-latest', 'Ministral 3 3B', 0.1, 0.1, undefined, 'default', 0, 0.01],
  ['ministral-3b', 'Ministral 3 3B', 0.1, 0.1, undefined, 'default', 0, 0.01],
  ['ministral-3b-2410', 'Ministral 3 3B', 0.1, 0.1, undefined, 'default', 0, 0.01],
  ['codestral-2508', 'Codestral', 0.3, 0.9],
  ['zai-glm-5-3', 'Z.ai GLM 5.3 (third-party hosted on La Plateforme)', 1.4, 4.4],
  // Cohere.
  ['command-a-03-2025', 'Command A', 2.5, 10],
  ['command-r-plus-08-2024', 'Command R+ (08-2024)', 2.5, 10],
  ['command-r-plus', 'Command R+ (04-2024, legacy)', 3, 15],
  ['command-r-08-2024', 'Command R (08-2024)', 0.15, 0.6],
  ['command-r', 'Command R (03-2024, legacy)', 0.5, 1.5],
  ['command-r7b-12-2024', 'Command R7B', 0.0375, 0.15],
  ['command-nightly', 'Command (legacy)', 1, 2],
  ['command-light-nightly', 'Command-light (legacy)', 0.3, 0.6],
  ['c4ai-aya-vision-32b', 'Aya Expanse / Aya Vision', 0.5, 1.5],
  // Meta API and Amazon.
  ['muse-wonder-1.0', 'Muse Wonder 1.0 (Meta Model API, preview)', 4, 20],
  ['muse-spark-1.3', 'Muse Spark 1.x (Standard mode)', 1.25, 4.25],
  ['muse-spark-1.2-contributor', 'Muse Spark 1.x (Contributor mode)', 0.1, 0.2],
  ['us.amazon.nova-micro-v1:0', 'Amazon Nova Micro', 0.035, 0.14],
  ['eu.amazon.nova-lite-v1:0', 'Amazon Nova Lite', 0.06, 0.24],
  ['apac.amazon.nova-pro-v1:0', 'Amazon Nova Pro', 0.8, 3.2],
  ['us.amazon.nova-premier-v1:0', 'Amazon Nova Premier', 2.5, 12.5],
  ['global.amazon.nova-2-lite-v1:0', 'Amazon Nova 2 Lite', 0.3, 2.5],
  ['global.amazon.nova-2-pro-v1:0', 'Amazon Nova 2 Pro (Preview)', 1.25, 10],
  ['amazon.nova-2-omni-v1:0', 'Amazon Nova 2 Omni (Preview)', 0.3, 2.5],
  // Microsoft.
  ['Phi-4', 'Phi-4', 0.125, 0.5],
  ['PHI-4-MINI-REASONING', 'Phi-4-mini / Phi-4-mini-reasoning', 0.075, 0.3],
  ['Phi-4-multimodal-instruct', 'Phi-4-multimodal (text + image)', 0.08, 0.32],
  ['Phi-4-reasoning-plus', 'Phi-4-reasoning / Phi-4-reasoning-plus', 0.125, 0.5],
  ['Phi-3.5-mini-instruct', 'Phi-3.5-mini / Phi-3-mini', 0.13, 0.52],
  ['Phi-3-small-8k-instruct', 'Phi-3-small', 0.15, 0.6],
  ['Phi-3-medium-128k-instruct', 'Phi-3-medium', 0.17, 0.68],
  ['Phi-3.5-MoE-instruct', 'Phi-3.5-MoE', 0.16, 0.64],
  // Alibaba, including dated snapshots and retirement routing.
  ['qwen3.8-max-0902', 'Qwen3.8-Max', 2, 6],
  ['qwen3.7-max-2026-06-08', 'Qwen3.7-Max', 2.5, 7.5],
  ['qwen-max', 'Qwen-Max (legacy stable alias)', 1.6, 6.4],
  ['qwen3.7-plus-2026-05-26', 'Qwen3.7-Plus', 0.4, 1.6],
  ['qwen3.6-plus-2026-04-02', 'Qwen3.6-Plus', 0.5, 3],
  ['qwen3.5-plus-2026-02-15', 'Qwen3.5-Plus', 0.4, 2.4],
  ['qwen-plus-2025-12-01', 'Qwen-Plus (stable alias + snapshots)', 0.4, 1.2],
  ['qwen3.8-flash', 'Qwen3.8-Flash', 0.15, 0.47],
  ['qwen3.7-flash-2026-07-15', 'Qwen3.7-Flash', 0.03, 0.13],
  ['qwen3.6-flash-2026-04-16', 'Qwen3.6-Flash', 0.25, 1.5],
  ['qwen3.5-flash-2026-02-23', 'Qwen3.5-Flash', 0.1, 0.4],
  ['qwen-flash-2025-07-28', 'Qwen-Flash (stable alias, successor of qwen-turbo)', 0.05, 0.4],
  ['qwen-turbo', 'Qwen-Flash (stable alias, successor of qwen-turbo)', 0.05, 0.4],
  ['qwen3.8-2.4t-a95b', 'Qwen3.8 open-weight (2.4T-A95B)', 2, 6],
  ['qwen3.8-27b', 'Qwen3.8 open-weight (27B)', 0.5, 3],
  ['qwen3.6-35b-a3b', 'Qwen3.6 open-weight (35B-A3B)', 0.375, 2.25],
  ['qwen3.6-27b', 'Qwen3.6 open-weight (27B)', 0.6, 3.6],
  ['qwen3.5-397b-a17b', 'Qwen3.5 open-weight (397B-A17B)', 0.6, 3.6],
  ['qwen3.5-122b-a10b', 'Qwen3.5 open-weight (122B-A10B)', 0.4, 3.2],
  ['qwen3.5-27b', 'Qwen3.5 open-weight (27B)', 0.3, 2.4],
  ['qwen3.5-35b-a3b', 'Qwen3.5 open-weight (35B-A3B)', 0.25, 2],
  ['qwen3-coder-flash-2025-07-28', 'Qwen3-Coder-Flash', 0.3, 1.5],
  ['qwen3-vl-plus', 'Qwen3-VL-Plus', 0.2, 1.6],
  ['qwen-vl-ocr-2025-11-20', 'Qwen-VL-OCR', 0.07, 0.16],
  ['qwen3-max-2025-09-23', 'Qwen3.7-Max', 2.5, 7.5],
  // Moonshot.
  ['kimi-k3', 'Kimi K3', 3, 15],
  ['kimi-k2.7-code', 'Kimi K2.7 Code', 0.95, 4],
  ['kimi-k2.7-code-highspeed', 'Kimi K2.7 Code (high-speed)', 1.9, 8],
  ['kimi-k2.6', 'Kimi K2.6', 0.95, 4],
  ['moonshot-v1-8k', 'Kimi K2.6', 0.95, 4],
  // Z.ai: Flash, FlashX, base and free-tier rows.
  ['glm-5.3', 'GLM-5.3', 1.4, 4.4],
  ['glm-5.2', 'GLM-5.2', 1.4, 4.4],
  ['glm-5.1', 'GLM-5.1', 1.4, 4.4],
  ['glm-5', 'GLM-5', 1, 3.2],
  ['glm-5.3-flash', 'GLM-5.3-Flash', 0.15, 0.5],
  ['glm-5.3-flashx', 'GLM-5.3-FlashX', 0.37, 1.25],
  ['glm-4.7', 'GLM-4.7', 0.6, 2.2],
  ['glm-4.6', 'GLM-4.6', 0.6, 2.2],
  ['glm-4.7-flashx', 'GLM-4.7-FlashX', 0.07, 0.4],
  ['glm-4.5', 'GLM-4.5', 0.6, 2.2],
  ['glm-4.5-x', 'GLM-4.5-X', 2.2, 8.9],
  ['glm-4.5-air', 'GLM-4.5-Air', 0.2, 1.1],
  ['glm-4.5-airx', 'GLM-4.5-AirX', 1.1, 4.5],
  ['glm-4-32b-0414-128k', 'GLM-4-32B-0414-128K', 0.1, 0.1],
  ['glm-4.6v-flash', 'GLM Flash (free tier: 4.7-Flash, 4.5-Flash, 4.6V-Flash)', 0, 0],
  ['glm-4.6v', 'GLM-4.6V', 0.3, 0.9],
  ['glm-4.6v-flashx', 'GLM-4.6V-FlashX', 0.04, 0.4],
  ['glm-4.5v', 'GLM-4.5V', 0.6, 1.8],
  ['glm-ocr', 'GLM-OCR', 0.03, 0.03],
  // MiniMax, Baidu and Cursor.
  ['MiniMax-M3', 'MiniMax-M3 (MiniMax API default)', 0.3, 1.2],
  ['MiniMax-M2.7', 'MiniMax-M2.7', 0.3, 1.2],
  ['MiniMax-M2.7-highspeed', 'MiniMax-M2.7-highspeed', 0.6, 2.4],
  ['MiniMax-M2.5', 'MiniMax-M2.5 (legacy)', 0.3, 1.2],
  ['MiniMax-M2.5-highspeed', 'MiniMax-M2.5-highspeed (legacy)', 0.6, 2.4],
  ['MiniMax-M2.1', 'MiniMax-M2.1 (legacy)', 0.3, 1.2],
  ['MiniMax-M2.1-highspeed', 'MiniMax-M2.1-highspeed (legacy)', 0.6, 2.4],
  ['MiniMax-M2', 'MiniMax-M2 (legacy)', 0.3, 1.2],
  ['ernie-5.1', 'ERNIE 5.1', 0.56, 2.53],
  ['ernie-5.0', 'ERNIE 5.0 (text / vision / deep-thinking)', 0.84, 3.38],
  ['ernie-4.5-turbo-128k', 'ERNIE 4.5 Turbo (32K / 128K)', 0.11, 0.45],
  ['ernie-4.5-turbo-vl-32k', 'ERNIE 4.5 Turbo VL', 0.42, 1.27],
  ['composer-2.5', 'Composer 2.5 (Cursor)', 0.5, 2.5],
  ['composer-1', 'Composer 1 (Cursor) (last known)', 1.25, 10],
  // Synthetic unknown suffixes deliberately select each vendor's catch-all.
  ['claude-opus-4-10', 'Claude (other)', 3, 15, undefined, 'default', 3.75, 0.3],
  ['gpt-5.1', 'GPT-5 / 5.x (other)', 1.25, 10, undefined, 'default', 0, 0.125],
  ['gemini-3-unknown', 'Gemini 3 (other)', 0.5, 3, undefined, 'default', 0, 0.05],
  ['gemini-unknown', 'Gemini (other)', 1.25, 10, undefined, 'default', 0, 0.125],
  ['mistral-unknown', 'Mistral (other)', 1.5, 7.5, undefined, 'default', 0, 0.15],
  ['command-unknown', 'Cohere (other)', 2.5, 10, undefined, 'default', 0, 0],
  ['muse-unknown', 'Meta (other)', 1.25, 4.25, undefined, 'default', 0, 0.15],
  ['nova-unknown', 'Amazon Nova (other)', 0.3, 2.5, undefined, 'default', 0, 0.075],
  ['phi-unknown', 'Phi (other)', 0.125, 0.5, undefined, 'default', 0, 0],
  ['qwen-unknown', 'Qwen (other)', 0.4, 1.2, undefined, 'default', 0, 0.08],
  ['kimi-unknown', 'Kimi / Moonshot (other)', 0.95, 4, undefined, 'default', 0, 0.16],
  ['glm-unknown', '(other)', 0.6, 2.2, undefined, 'default', 0, 0.11],
  ['minimax-unknown', 'MiniMax (other)', 0.3, 1.2, undefined, 'default', 0.375, 0.06],
  ['ernie-unknown', '(other)', 0.11, 0.45, undefined, 'default', 0, 0.03],
  ['unknown-model', 'Unknown model', 3, 15, undefined, 'default', 3.75, 0.3],
  // V3.1/V3.2 suffixes are unpriced; SambaNova lists only the exact bare ids.
  ['deepseek-v3.1-terminus', 'Unknown model', 3, 15, undefined, 'default', 3.75, 0.3],
  ['deepseek-v3.2-exp', 'Unknown model', 3, 15, undefined, 'default', 3.75, 0.3],
  ['deepseek-v3.1:671b', 'Unknown model', 3, 15, undefined, 'default', 3.75, 0.3],
  ['deepseek-v3.1-terminus', 'Unknown model', 3, 15, 'DeepSeek API', 'default', 3.75, 0.3],
  ['deepseek-v3.2-exp', 'Unknown model', 3, 15, 'DeepSeek chat', 'default', 3.75, 0.3],
  ['deepseek-v3.1:671b', 'Unknown model', 3, 15, 'DeepSeek API', 'default', 3.75, 0.3],
  ['deepseek-v3.1-terminus', 'Unknown model', 3, 15, 'SambaNova Cloud', 'default', 3.75, 0.3],
  ['deepseek-v3.2-exp', 'Unknown model', 3, 15, 'SambaNova Cloud', 'default', 3.75, 0.3],
  ['deepseek-v3.1:671b', 'Unknown model', 3, 15, 'SambaNova Cloud', 'default', 3.75, 0.3],
  ['deepseek-v3.10', 'DeepSeek chat (V3 list)', 0.27, 1.1, undefined, 'default', 0, 0.07],
  ['deepseek-v3', 'DeepSeek chat (V3 list)', 0.27, 1.1, undefined, 'default', 0, 0.07],
  // Platform overrides and the same defect ids without that platform.
  ['qwen/qwen3-32b', 'Qwen3 32B (Groq, last known)', 0.29, 0.59, 'Groq', 'override'],
  ['deepseek-ai/DeepSeek-V4-Pro-0813', 'DeepSeek V4 Pro 0813 (DeepInfra)', 1.3, 2.6, 'DeepInfra', 'override'],
  ['Qwen/Qwen3.5-397B-A17B', 'Qwen3.5-397B-A17B (DeepInfra)', 0.45, 3, 'DeepInfra', 'override'],
  ['meta-llama/Llama-4-Scout-17B-16E-Instruct', 'Llama 4 Scout (Together, no longer serverless)', 0.18, 0.59, 'Together AI', 'override'],
  ['meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Llama 3.1 8B Instruct Turbo (Together) (last known)', 0.18, 0.18, 'Together AI', 'override'],
  ['deepseek-ai/DeepSeek-R1', 'DeepSeek-R1 (Together) (last known)', 3, 7, 'Together AI', 'override'],
  ['deepseek-ai/DeepSeek-V3', 'DeepSeek-V3 (Together) (last known)', 1.25, 1.25, 'Together AI', 'override'],
  ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Llama 3.3 70B Instruct Turbo (DeepInfra)', 0.1, 0.32, 'DeepInfra', 'override'],
  ['meta-llama/Llama-4-Scout-17B-16E-Instruct', 'Llama 4 Scout (DeepInfra)', 0.1, 0.3, 'DeepInfra', 'override'],
  ['openai/gpt-oss-120b', 'gpt-oss-120b (DeepInfra)', 0.037, 0.17, 'DeepInfra', 'override'],
  ['openai/gpt-oss-20b', 'gpt-oss-20b (DeepInfra)', 0.03, 0.14, 'DeepInfra', 'override'],
  ['moonshotai/Kimi-K3', 'Kimi-K3 (DeepInfra)', 2.85, 14.25, 'DeepInfra', 'override'],
  ['minimax-m3', 'MiniMax-M3 (SambaNova)', 0.6, 2.4, 'SambaNova Cloud', 'override', 0, 0.06],
  ['deepseek-r1', 'DeepSeek-R1 (SambaNova) (last known)', 5, 7, 'SambaNova Cloud', 'override', 0, 0],
  ['deepseek-v3-0324', 'DeepSeek-V3-0324 (SambaNova) (last known)', 3, 4.5, 'SambaNova Cloud', 'override', 0, 0],
  ['qwen3-32b', 'Qwen3-32B (SambaNova) (last known)', 0.4, 0.8, 'SambaNova Cloud', 'override', 0, 0],
  ['gpt-oss-120b', 'gpt-oss-120b (Cerebras)', 0.25, 0.69, 'Cerebras', 'override'],
  ['deepseek-v3.1', 'DeepSeek-V3.1 / V3.2 (SambaNova)', 3, 4.5, 'SambaNova Cloud', 'override', 0, 0],
  ['deepseek-v3.2', 'DeepSeek-V3.1 / V3.2 (SambaNova)', 3, 4.5, 'SambaNova Cloud', 'override', 0, 0],
  ['deepseek-v3.1', 'Unknown model', 3, 15, undefined, 'default', 3.75, 0.3],
  ['deepseek-v3.2', 'Unknown model', 3, 15, undefined, 'default', 3.75, 0.3],
  ['deepseek-v3.1', 'Unknown model', 3, 15, 'DeepSeek chat', 'default', 3.75, 0.3],
  ['deepseek-v3.2', 'Unknown model', 3, 15, 'DeepSeek chat', 'default', 3.75, 0.3],
  ['deepseek-v3.1', 'Unknown model', 3, 15, 'DeepSeek API', 'default', 3.75, 0.3],
  ['deepseek-v3.2', 'Unknown model', 3, 15, 'DeepSeek API', 'default', 3.75, 0.3],
  ['minimax-m3', 'MiniMax-M3 (MiniMax API default)', 0.3, 1.2, 'MiniMax'],
  ['deepseek-r1', 'DeepSeek Reasoner', 0.55, 2.19],
  ['deepseek-r1', 'DeepSeek Reasoner', 0.55, 2.19, 'DeepSeek API'],
  ['deepseek-v3-0324', 'DeepSeek chat (V3 list)', 0.27, 1.1],
  ['deepseek-v3-0324', 'DeepSeek chat (V3 list)', 0.27, 1.1, 'DeepSeek API'],
  ['qwen3-32b', 'Qwen-Plus (stable alias + snapshots)', 0.4, 1.2],
  ['qwen3-32b', 'Qwen-Plus (stable alias + snapshots)', 0.4, 1.2, 'Alibaba Model Studio'],
];

// Each defect group has a negative assertion, independent of the positive table.
const MUST_NOT = [
  ['deepseek-v3.1-terminus', undefined, 'DeepSeek chat (V3 list)'],
  ['deepseek-v3.2-exp', undefined, 'DeepSeek chat (V3 list)'],
  ['deepseek-v3.1:671b', undefined, 'DeepSeek chat (V3 list)'],
  ['deepseek-v3.1-terminus', 'SambaNova Cloud', 'DeepSeek-V3.1 / V3.2 (SambaNova)'],
  ['deepseek-v3.2-exp', 'SambaNova Cloud', 'DeepSeek-V3.1 / V3.2 (SambaNova)'],
  ['deepseek-v3.1:671b', 'SambaNova Cloud', 'DeepSeek-V3.1 / V3.2 (SambaNova)'],
  ['ministral-14b', undefined, 'Mistral (other)'],
  ['deepseek-v3.1', undefined, 'DeepSeek-V3.1 / V3.2 (SambaNova)'],
  ['deepseek-v3.2', 'DeepSeek API', 'DeepSeek-V3.1 / V3.2 (SambaNova)'],
  ['minimax-m3', 'SambaNova Cloud', 'MiniMax-M3 (MiniMax API default)'],
  ['deepseek-r1', 'SambaNova Cloud', 'DeepSeek Reasoner'],
  ['deepseek-v3-0324', 'SambaNova Cloud', 'DeepSeek chat (V3 list)'],
  ['qwen3-32b', 'SambaNova Cloud', 'Qwen-Plus (stable alias + snapshots)'],
  ['ministral-8b-2410', undefined, 'Mistral (other)'],
  ['ministral-3b-2410', undefined, 'Mistral (other)'],
  ['ministral-8b', undefined, 'Ministral 3 3B'],
  ['ministral-3b', undefined, 'Ministral 3 8B'],
  ['gemini-3.6-flash-lite', undefined, 'Gemini 3.6/3.7/3.8 Flash'],
  ['gemini-3.7-flash-lite', undefined, 'Gemini 3.6/3.7/3.8 Flash'],
  ['gemini-3.8-flash-lite', undefined, 'Gemini 3.6/3.7/3.8 Flash'],
  ['claude-opus-4-0', undefined, 'Claude (other)'],
  ['claude-opus-4-0-20250514', undefined, 'Claude (other)'],
  ['claude-opus-4-5', undefined, 'Claude Opus 4 / 4.1'],
];

// These rows have no honest winning id: aliases intercept all documented spellings.
// Values: [reason, input, output, cw, cr]; pin the dormant rows directly.
const NO_KNOWN_ID = {
  '^grok-4(-0709|-latest)?$': ['Every documented id aliases to grok-4.3.', 1.25, 2.5, 0, 0.2],
  '^grok-4-fast': ['Every documented id aliases to grok-4.3; no other supported id is documented.', 1.25, 2.5, 0, 0.2],
  '^grok-4-1-fast': ['Every documented id aliases to grok-4.3; no other supported id is documented.', 1.25, 2.5, 0, 0.2],
  '^grok-3(-latest|-beta|-fast(-latest|-beta)?)?$': ['Every admitted id aliases to grok-4.3.', 1.25, 2.5, 0, 0.2],
  '^sonar-reasoning$': ['Its sole id aliases to sonar-reasoning-pro.', 1, 5, 0, 0],
  '^qwen3(\\.6)?-max(-preview|-\\d{4}-\\d{2}-\\d{2})?$': ['Every documented snapshot aliases to qwen3.7-max.', 1.2, 6, 0, 0.24],
};
const RETIRED_WITHOUT_SUCCESSOR = ['groq/compound', 'groq/compound-mini'];
// Await vendor verification in T4b. Report the count; never assert their prices.
const PENDING_T4B = [
  'gpt-5-pro', 'gpt-5.2-pro', 'gpt-5-codex-mini', 'gpt-5.1-codex-mini',
  'claude-3-opus', 'claude-3-opus-20240229', 'open-mistral-nemo',
  'devstral-small-2507', 'deepseek-v4-pro',
];
const isCatchAll = (r) => r.pat === '.*' || /\(other\)/i.test(r.label) || [
  'ChatGPT / Copilot (auto)', 'Grok 4 (xAI list)', 'DeepSeek chat (V3 list)', 'Perplexity Sonar',
].includes(r.label);
const rowKey = (r, platform = '') => JSON.stringify([platform, r.pat]);

export async function run() {
  const results = [];
  const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });
  // Empty persisted prices; these parts define DOM helpers but do not invoke them.
  const context = vm.createContext({ localStorage: { getItem() { return null; } }, document: { getElementById() { return null; } } });   // 03-pricing.js clears its repair notice on load (T4a-2); nothing to clear here
  for (const file of ['01-helpers.js', '02-prices.js', '03-pricing.js', '05-connectors.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/js', file), 'utf8'), context, { filename: file });
  }
  const { Pricing, DEFAULT_PRICES, PRICE_OVERRIDES, MODEL_ALIASES, CONNECTORS } = vm.runInContext(
    'Pricing.load(); ({ Pricing, DEFAULT_PRICES, PRICE_OVERRIDES, MODEL_ALIASES, CONNECTORS })', context);
  const seen = new Set();
  check('price resolution: at least 150 distinct model ids', new Set(CASES.map(c => c[0].toLowerCase())).size >= 150);
  const pending = new Set(PENDING_T4B);
  check('price resolution: pending T4b ids excluded (count ' + PENDING_T4B.length + ')',
    [...CASES, ...MUST_NOT].every(c => !pending.has(c[0].toLowerCase())));
  for (const [id, label, input, output, platform, source = 'default', cw, cr] of CASES) {
    const got = Pricing.resolve(id, platform);
    const pass = got.label === label && got.in === input && got.out === output && got.source === source
      && (cw === undefined || got.cw === cw) && (cr === undefined || got.cr === cr)
      && (source !== 'override' || got.overrideFor === platform)
      && (label !== 'Unknown model' || got.fallback === true);
    check('price resolution: ' + id + ' @ ' + (platform || '(none)'), pass,
      JSON.stringify({ expected: [label, input, output, source, cw, cr], got: [got.label, got.in, got.out, got.source, got.cw, got.cr] }));
    if (pass) seen.add(rowKey(got, source === 'override' ? platform : ''));
  }
  for (const [id, platform, forbidden] of MUST_NOT) {
    const got = Pricing.resolve(id, platform);
    check('price resolution MUST-NOT: ' + id + ' @ ' + (platform || '(none)'),
      got.label !== forbidden, 'forbidden=' + forbidden + '; got=' + got.label);
  }
  const uncovered = [
    ...DEFAULT_PRICES.filter(r => !Object.hasOwn(NO_KNOWN_ID, r.pat)
      && !seen.has(rowKey(r))).map(r => 'default: ' + r.label),
    ...PRICE_OVERRIDES.filter(r => !seen.has(rowKey(r, r.platform))).map(r => r.platform + ': ' + r.label),
  ];
  check('price resolution: every non-exempt default and every override has a winning case', !uncovered.length, uncovered.join('; '));
  for (const [pat, [, input, output, cw, cr]] of Object.entries(NO_KNOWN_ID)) {
    const row = DEFAULT_PRICES.find(r => r.pat === pat);
    check('price resolution: NO_KNOWN_ID prices ' + pat,
      row && row.in === input && row.out === output && row.cw === cw && row.cr === cr,
      JSON.stringify({ expected: [input, output, cw, cr], got: row && [row.in, row.out, row.cw, row.cr] }));
  }
  const stale = Object.entries(NO_KNOWN_ID).filter(([pat, [reason]]) =>
    !reason || !DEFAULT_PRICES.some(r => r.pat === pat) || seen.has(rowKey({ pat })));
  check('price resolution: NO_KNOWN_ID exceptions remain necessary (count ' + Object.keys(NO_KNOWN_ID).length + ')',
    !stale.length, stale.map(([pat]) => pat).join('; '));
  const platforms = new Set(CONNECTORS.map(c => c.platform));
  for (const row of PRICE_OVERRIDES) {
    check('price resolution: registered override platform for ' + row.label,
      platforms.has(row.platform), row.platform);
  }
  // Metadata only: null successors are omitted by the generator, so check the declarations too.
  const retired = JSON.parse(fs.readFileSync(path.join(ROOT,
    'docs/superpowers/specs/2026-10-15-price-rows.json'), 'utf8')).retired_aliases;
  const aliasIssues = retired.filter(a => a.successor
    ? MODEL_ALIASES[a.id.toLowerCase()] !== a.successor
    : !RETIRED_WITHOUT_SUCCESSOR.includes(a.id.toLowerCase())).map(a => a.id);
  check('price resolution: alias declarations rendered or explicitly retired', !aliasIssues.length, aliasIssues.join('; '));
  for (const [id, successor] of Object.entries(MODEL_ALIASES)) {
    const got = Pricing.resolve(successor);
    check('price resolution: specific alias successor for ' + id,
      !isCatchAll(got) && !got.fallback, successor + ' -> ' + got.label);
  }
  for (const id of RETIRED_WITHOUT_SUCCESSOR) {
    check('price resolution: retired without successor ' + id,
      retired.some(a => a.id.toLowerCase() === id && a.successor === null)
      && !Object.hasOwn(MODEL_ALIASES, id) && Pricing.resolve(id).fallback === true);
  }
  const patterns = DEFAULT_PRICES.map(r => r.pat);
  const duplicates = patterns.filter((pat, i) => patterns.indexOf(pat) !== i);
  check('price resolution: unique default patterns', !duplicates.length, duplicates.join('; '));
  const overrideKeys = PRICE_OVERRIDES.map(r => rowKey(r, r.platform));
  const duplicateOverrides = overrideKeys.filter((key, i) => overrideKeys.indexOf(key) !== i);
  check('price resolution: unique override platform/pattern pairs', !duplicateOverrides.length, duplicateOverrides.join('; '));
  const invalid = [];
  for (const row of [...DEFAULT_PRICES, ...PRICE_OVERRIDES]) {
    try { new RegExp(row.pat, 'i'); } catch (e) { invalid.push(row.label + ': ' + e.message); }
  }
  check('price resolution: every pattern compiles', !invalid.length, invalid.join('; '));
  const counts = { table: CASES.length, mustNot: MUST_NOT.length,
    noKnownId: Object.keys(NO_KNOWN_ID).length, pendingT4b: PENDING_T4B.length };
  return { pass: results.every(r => r.pass), detail: JSON.stringify(counts), results };
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const r = await run();
  console.log(r.detail);
  for (const x of r.results) console.log((x.pass ? 'PASS' : 'FAIL') + '  ' + x.name + (x.pass ? '' : '  - ' + x.detail));
  console.log('\n' + r.results.filter(x => x.pass).length + '/' + r.results.length + ' checks passed');
  process.exitCode = r.pass ? 0 : 1;
}
