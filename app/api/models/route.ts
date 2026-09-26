/**
 * GET /api/models — the model catalog plus live availability.
 *
 * The picker uses `available` to grey out models whose provider has no key,
 * rather than letting the user select one that will fail at request time.
 */

import { availableModels } from "@/lib/ai";
import { allCredentialStatus } from "@/lib/ai/credentials";
import { ROLES } from "@/lib/agents/roles";

export const runtime = "nodejs";

export async function GET() {
  const [models, providers] = await Promise.all([
    availableModels(),
    allCredentialStatus(),
  ]);

  return Response.json({
    models: models.map(({ spec, available }) => ({
      id: spec.id,
      provider: spec.provider,
      label: spec.label,
      blurb: spec.blurb,
      tier: spec.tier,
      contextWindow: spec.contextWindow,
      pricing: spec.pricing,
      agentic: spec.agentic,
      supportsCaching: spec.supportsCaching,
      supportsThinking: spec.supportsThinking,
      available,
    })),
    providers,
    anyConfigured: providers.some((p) => p.configured),
    roles: Object.values(ROLES).map((role) => ({
      id: role.id,
      label: role.label,
      blurb: role.blurb,
      accent: role.accent,
      tier: role.tier,
    })),
  });
}
