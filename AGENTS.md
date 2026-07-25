## Project
NutriPulse MCP — a biometric-aware health & nutrition MCP server built with the 
NitroStack TypeScript SDK, deployed to NitroCloud, exposed to ChatGPT as a 
connector. Hackathon deliverable, ~24h build.

## Hard rules
1. NEVER invent NitroStack APIs. Consult ./docs/NITROSTACK_REFERENCE.md. If 
   something isn't in there, STOP and ask me — do not improvise.
2. All server logic is deterministic and server-side. The host LLM narrates 
   results; it never performs the reasoning. Every tool must return a correct 
   answer even if the host ignores all prompts.
3. Every tool returns structured JSON with a `calculation_trace` field showing 
   inputs, rules applied, and intermediate values. No unexplained numbers.
4. Safety rules are absolute. Allergen and drug-interaction BLOCKs can never be 
   overridden by any scoring, optimisation, or resolver logic.
5. Never output a diagnosis. Lab values are reported against reference ranges 
   only, with an explicit clinician-referral flag when out of range. Never give 
   medication advice.
6. Strict TypeScript. Zod schemas on every tool input. No `any` in business logic.
7. Tool descriptions are written for an LLM to read — state exactly when to call 
   the tool and what it returns.
8. After each feature, the server must still build and start cleanly. Never leave 
   the repo broken.

## Build order (do not jump ahead)
Phase 1 data layer → Phase 2 resources → Phase 3 core tools → Phase 4 resolver 
→ Phase 5 differentiator tools + widgets → Phase 6 prompts → Phase 7 deploy.

## Stack
TypeScript, NitroStack SDK/CLI, Zod, in-repo JSON data store (no external DB), 
USDA FoodData Central API, Open-Meteo API.
