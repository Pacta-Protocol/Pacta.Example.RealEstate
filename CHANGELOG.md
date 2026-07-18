# Changelog

Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
while on 0.x, minor bumps may carry breaking changes and each entry says so.

## [0.1.0] - 2026-07-17

First tagged release. Built against Pacta.Protocol 0.1.0.

### Added

- LandBridge: cross-border real-estate due diligence in Costa Rica run end to
  end by an LLM copilot over Pacta's 12 MCP tools - discovery, contracting,
  escrow, registry-verified proofs, a caught fraudulent proof, dispute,
  slashing and re-hire.
- Model-agnostic copilot: native Claude API loop, or any OpenAI-compatible
  endpoint (Ollama local by default, vLLM, OpenRouter) - fully local operation
  with open weights, no key needed.
- Deterministic roundtrip (`npm run roundtrip`): a scripted buyer drives the
  same MCP surface without any LLM, then audits the outcome over REST; exits 0
  only if every check passes.
- Unit/integration tests (streaming SSE accumulator, tool conversion, full
  loop against a mock endpoint) and CI running tests + roundtrip on every push.

[0.1.0]: https://github.com/Pacta-Protocol/Pacta.Example.RealEstate/releases/tag/v0.1.0
