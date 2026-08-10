# Provider catalog

ClaudeThing recognizes every provider below. Native collectors refresh directly from local sign-in state; bridge providers accept the same bounded display data from an owner-controlled local JSON integration. Authentication secrets always stay on the host.

| Provider | Integration | What it can show |
| --- | --- | --- |
| Codex (`codex`) | Native collector | Shows signed-in Codex limits, reset credits, token totals, and locally reconstructed usage history. |
| OpenAI (`openai`) | JSON bridge | Displays organization API usage, spend, budgets, and credit balances supplied by an owner-controlled integration. |
| Azure OpenAI (`azureopenai`) | JSON bridge | Monitors Azure-hosted model deployments, request activity, availability, and cost data from your Azure environment. |
| Claude (`claude`) | Native collector | Shows Claude current and weekly limits, reset timing, token totals, and local activity history when available. |
| Cursor (`cursor`) | Native collector | Tracks included requests, on-demand usage, plan identity, token activity, and recent Cursor cost history. |
| OpenCode (`opencode`) | JSON bridge | Presents workspace subscription consumption, remaining capacity, and reset timing from an OpenCode account integration. |
| OpenCode Go (`opencodego`) | JSON bridge | Surfaces OpenCode Go usage windows and locally observed quota data for the selected workspace. |
| Alibaba Coding Plan (`alibaba`) | JSON bridge | Displays Alibaba coding-plan allowances, consumed capacity, remaining quota, and upcoming resets. |
| Alibaba Token Plan (`alibabatokenplan`) | JSON bridge | Tracks Alibaba token-plan credits, token consumption, balances, and billing-period resets. |
| Qwen Cloud (`qwencloud`) | JSON bridge | Shows Qwen individual plan consumption across short rolling windows and longer weekly limits. |
| Gemini (`gemini`) | Native collector | Reads Gemini CLI authorization to display every model quota bucket and account tier the credential exposes. |
| Antigravity (`antigravity`) | JSON bridge | Presents locally collected Antigravity model allowances, remaining capacity, health, and refresh timing. |
| Droid (`droid`) | Native collector | Tracks Droid standard and core limits, extra-usage enablement, available balance, and organization plan identity. |
| Copilot (`copilot`) | Native collector | Shows GitHub Copilot chat, completion, and premium-request quotas with entitlements, overage, and reset timing. |
| Devin (`devin`) | JSON bridge | Displays Devin daily and weekly utilization, remaining allowance, reset timing, and account identity. |
| z.ai (`zai`) | JSON bridge | Tracks personal or team z.ai quotas, hourly and rolling windows, MCP activity, and remaining capacity. |
| Manus (`manus`) | JSON bridge | Shows Manus credit balance, monthly allocation, daily refresh credits, and consumption history. |
| MiniMax (`minimax`) | JSON bridge | Presents MiniMax coding-plan usage, remaining allowance, plan details, and renewal timing. |
| T3 Chat (`t3chat`) | JSON bridge | Separates T3 Chat base-plan consumption from paid overage so both usage pools remain visible. |
| ZoomMate (`zoommate`) | JSON bridge | Tracks ZoomMate credit consumption, remaining balance, plan identity, and historical usage. |
| Kimi (`kimi`) | JSON bridge | Shows Kimi weekly allowance alongside its shorter rolling rate limit and reset schedule. |
| Kilo (`kilo`) | JSON bridge | Displays Kilo Pass quota usage, credit availability, plan identity, and renewal information. |
| Kiro (`kiro`) | JSON bridge | Tracks Kiro monthly credits, bonus credits, consumed allowance, and billing-cycle reset timing. |
| Vertex AI (`vertexai`) | JSON bridge | Combines Google Cloud model activity with estimated token cost and project-level usage history. |
| Augment (`augment`) | JSON bridge | Shows Augment credit consumption, remaining capacity, plan information, and usage trends. |
| Amp (`amp`) | JSON bridge | Displays Amp plan usage, remaining free allowance, and the next quota refresh. |
| Ollama (`ollama`) | JSON bridge | Surfaces Ollama Cloud limits, consumed usage, available capacity, and account status. |
| Synthetic (`synthetic`) | JSON bridge | Tracks Synthetic rolling token quotas, weekly allowances, search limits, and their independent reset times. |
| JetBrains AI (`jetbrains`) | JSON bridge | Shows locally reported JetBrains AI monthly credits, usage, remaining balance, and renewal date. |
| Warp (`warp`) | JSON bridge | Displays Warp request limits, monthly credits, remaining capacity, and account plan information. |
| ElevenLabs (`elevenlabs`) | JSON bridge | Tracks ElevenLabs character allowance, consumed characters, remaining voice slots, and billing reset. |
| OpenRouter (`openrouter`) | JSON bridge | Shows OpenRouter credit balance, aggregate spend, request volume, and usage history across routed models. |
| Windsurf (`windsurf`) | JSON bridge | Presents Windsurf plan allowances, current consumption, remaining capacity, and renewal timing. |
| Zed (`zed`) | JSON bridge | Tracks Zed plan usage, edit-prediction quota, billing cycle, credits, and account payment state. |
| Perplexity (`perplexity`) | JSON bridge | Displays Perplexity account credits, consumed allowance, remaining balance, and usage history. |
| Xiaomi MiMo (`mimo`) | JSON bridge | Shows Xiaomi MiMo account balance, token-plan utilization, available quota, and resets. |
| Doubao (`doubao`) | JSON bridge | Monitors Doubao and Volcengine Ark request capacity, validation status, and observed consumption. |
| Sakana AI (`sakana`) | JSON bridge | Displays Sakana AI short-window and weekly quota consumption with independent reset timing. |
| Abacus AI (`abacus`) | JSON bridge | Tracks Abacus AI compute credits across ChatLLM or RouteLLM usage and remaining capacity. |
| Mistral (`mistral`) | JSON bridge | Shows Mistral API spend, available credits, monthly-plan utilization, and billing-cycle history. |
| DeepSeek (`deepseek`) | JSON bridge | Displays DeepSeek paid and promotional balances separately with aggregate remaining credit. |
| Fireworks (`fireworks`) | JSON bridge | Tracks Fireworks account spend over the recent billing period with project or account identity. |
| DeepInfra (`deepinfra`) | JSON bridge | Shows DeepInfra prepaid balance, current-month spend, configured spending limit, and remaining headroom. |
| Moonshot / Kimi API (`moonshot`) | JSON bridge | Displays Moonshot or Kimi API balance, consumed credit, and account-level usage history. |
| Venice (`venice`) | JSON bridge | Tracks Venice DIEM or dollar-denominated balances, consumption, and recent account activity. |
| Codebuff (`codebuff`) | JSON bridge | Shows Codebuff credit balance, weekly rate-limit utilization, remaining allowance, and resets. |
| Crof (`crof`) | JSON bridge | Displays Crof dollar credits with optional request-quota consumption and remaining capacity. |
| Command Code (`commandcode`) | JSON bridge | Tracks Command Code monthly dollar credits, used balance, remaining allowance, and renewal date. |
| Qoder (`qoder`) | JSON bridge | Shows Qoder large-model credits, consumed quota, remaining balance, and billing period. |
| StepFun (`stepfun`) | JSON bridge | Displays StepFun plan identity plus five-hour and weekly rate-limit usage and resets. |
| AWS Bedrock (`bedrock`) | JSON bridge | Presents AWS Bedrock spend, monthly budgets, remaining budget, and optional model activity metrics. |
| Grok (`grok`) | JSON bridge | Shows Grok plan or billing usage, account identity, remaining capacity, and refresh timing. |
| GroqCloud (`groq`) | JSON bridge | Tracks GroqCloud requests, tokens, cache efficiency, limits, and historical operational metrics. |
| LLM Proxy (`llmproxy`) | JSON bridge | Displays aggregate proxy quota and spend with optional per-provider request and token breakdowns. |
| ClawRouter (`clawrouter`) | JSON bridge | Shows ClawRouter monthly budget, spend, requests, tokens, and routed-provider distribution. |
| sub2api (`sub2api`) | JSON bridge | Tracks self-hosted gateway key quotas, subscription limits, wallet balance, and key-level usage. |
| Wayfinder (`wayfinder`) | JSON bridge | Monitors local routing health, route selection, savings, request volume, and decision latency. |
| LiteLLM (`litellm`) | JSON bridge | Shows LiteLLM personal and team budgets, current spend, remaining headroom, and proxy activity. |
| Deepgram (`deepgram`) | JSON bridge | Aggregates Deepgram speech, agent, token, and text-to-speech usage with cost or capacity metrics. |
| Poe (`poe`) | JSON bridge | Displays current Poe point balance, recent point consumption, and daily usage history. |
| Chutes (`chutes`) | JSON bridge | Tracks Chutes subscription, rolling and monthly quotas, pay-as-you-go usage, and reset schedules. |
| Neuralwatt (`neuralwatt`) | JSON bridge | Shows Neuralwatt subscription energy usage in kilowatt-hours alongside prepaid credit balance. |
| ZenMux (`zenmux`) | JSON bridge | Displays ZenMux five-hour and seven-day quotas plus pay-as-you-go balance and resets. |
| xAI (`xai`) | JSON bridge | Tracks xAI team prepaid credit, daily platform spend, remaining balance, and historical cost. |
| IBM Bob (`ibmbob`) | JSON bridge | Shows IBM Bob monthly Bobcoin budget and consumption across the selected subscription teams. |

An unlisted provider can also use the JSON bridge with a safe lowercase id. See [provider setup](PROVIDERS.md) for the contract and installation paths.
