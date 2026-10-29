use dekopon_capability::EffectKind;
use dekopon_core::{
    CapabilityId, ExternalSubject, GroupId, PrincipalId, ProviderId, RiskLevel, SecretDrn,
};
use dekopon_policy::{
    PolicyContext, PolicyConversation, PolicyEngine, PolicyRequest, PolicyTarget, PolicyWorld,
};
use serde::Deserialize;
use serde_json::json;
use wasm_bindgen::prelude::*;

// This bridge consumes explicit engine facts, never broker config or bundle files.
// Bundle v1 supplies no complete world; the Studio always passes None for it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorldFacts {
    principals: Vec<PrincipalId>,
    capabilities: Vec<CapabilityFact>,
    subjects: Vec<(ExternalSubject, PrincipalId)>,
    groups: Vec<(PrincipalId, GroupId)>,
    secrets: Vec<SecretDrn>,
    strict: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CapabilityFact {
    id: CapabilityId,
    provider: ProviderId,
    effect: EffectKind,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RequestFacts {
    principal: PrincipalId,
    capability: CapabilityId,
    provider: ProviderId,
    effect: EffectKind,
    risk: RiskLevel,
    space: Option<PrincipalId>,
    context: ContextFacts,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContextFacts {
    via: Option<String>,
    subject: Option<String>,
    agent: Option<String>,
    transport_kind: Option<String>,
    transport: Option<String>,
    trigger: Option<String>,
    started_by: Option<String>,
    conversation: Option<ConversationFacts>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConversationFacts {
    kind: String,
    container: Option<String>,
    id: String,
    thread: Option<String>,
}

fn evaluate_known(
    policy: &str,
    world: WorldFacts,
    request: RequestFacts,
) -> Result<String, &'static str> {
    let read_only = world
        .capabilities
        .iter()
        .filter(|c| c.effect == EffectKind::ReadOnly)
        .map(|c| c.id.clone())
        .collect::<Vec<_>>();
    let engine_world = PolicyWorld::new(
        world.principals,
        world.capabilities.into_iter().map(|c| (c.id, c.provider)),
    )
    .map_err(|_| "invalid-world")?
    .with_subjects(world.subjects)
    .with_group_members(world.groups)
    .with_read_only(read_only)
    .with_secrets(world.secrets);
    let engine = if world.strict {
        PolicyEngine::new(policy, &engine_world).map_err(|_| "invalid-policy")?
    } else {
        PolicyEngine::new_lenient(policy, &engine_world)
            .map_err(|_| "invalid-policy")?
            .0
    };
    let context = request.context;
    let proposed = PolicyRequest {
        principal: request.principal,
        target: PolicyTarget::Capability {
            capability: request.capability,
            provider: request.provider,
            effect: request.effect,
            risk: request.risk,
        },
        context: PolicyContext {
            via: context.via,
            subject: context.subject,
            agent: context.agent,
            transport_kind: context.transport_kind,
            transport: context.transport,
            trigger: context.trigger,
            started_by: context.started_by,
            conversation: context.conversation.map(|c| PolicyConversation {
                kind: c.kind,
                container: c.container,
                id: c.id,
                thread: c.thread,
            }),
        },
    };
    let asker = engine.authorize(proposed.clone());
    if asker.refusal.is_some() {
        return Err("invalid-request");
    }
    let space = request.space.map(|principal| {
        engine.authorize(PolicyRequest {
            principal,
            ..proposed
        })
    });
    if space.as_ref().is_some_and(|s| s.refusal.is_some()) {
        return Err("invalid-request");
    }
    Ok(json!({
        "kind": "evaluation", "engine": "dekopon-policy 0.70.0",
        "askerAllowed": asker.allowed, "spaceAllowed": space.as_ref().map(|s| s.allowed),
        "allowed": asker.allowed && space.as_ref().is_none_or(|s| s.allowed),
        "policyIds": asker.determining_policy_ids,
        "spacePolicyIds": space.as_ref().map(|s| &s.determining_policy_ids),
        "errorsPresent": asker.errors_present || space.as_ref().is_some_and(|s| s.errors_present),
    })
    .to_string())
}

#[wasm_bindgen]
pub fn evaluate(policy: &str, world_json: Option<String>, request_json: &str) -> String {
    let Some(world_json) = world_json else {
        return json!({ "kind": "gap", "engine": "dekopon-policy 0.70.0", "reason": "missing-world", "missing": "provider-inventory" }).to_string();
    };
    let result = serde_json::from_str::<WorldFacts>(&world_json)
        .map_err(|_| "invalid-world")
        .and_then(|world| {
            serde_json::from_str::<RequestFacts>(request_json)
                .map_err(|_| "invalid-request")
                .and_then(|request| evaluate_known(policy, world, request))
        });
    result.unwrap_or_else(|reason| json!({ "kind": "gap", "reason": reason }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_provider_inventory_never_builds_a_guessed_world() {
        let result: serde_json::Value =
            serde_json::from_str(&evaluate("not parsed without a world", None, "{}")).unwrap();
        assert_eq!(result["kind"], "gap");
        assert_eq!(result["reason"], "missing-world");
    }

    #[test]
    fn explicit_engine_facts_are_evaluated_by_the_published_crate() {
        // Engine bridge test, not a bundle what-if: no bundle claims this inventory.
        let world = json!({ "principals": ["alice"], "capabilities": [{ "id": "fixture.read", "provider": "fixture", "effect": "read-only" }],
            "subjects": [], "groups": [], "secrets": [], "strict": true }).to_string();
        let request = json!({ "principal": "alice", "capability": "fixture.read", "provider": "fixture", "effect": "read-only", "risk": "Low", "context": { "via": "dekopon-gatewayd", "agent": "fixture-agent" } }).to_string();
        let allow = r#"@id("fixture-read") permit(principal == Dekopon::Principal::"alice", action == Dekopon::Action::"fixture.read", resource == Dekopon::Provider::"fixture");"#;
        let allowed: serde_json::Value =
            serde_json::from_str(&evaluate(allow, Some(world.clone()), &request)).unwrap();
        assert_eq!(allowed["kind"], "evaluation", "{allowed}");
        assert_eq!(allowed["allowed"], true);
        let denied: serde_json::Value =
            serde_json::from_str(&evaluate("", Some(world), &request)).unwrap();
        assert_eq!(denied["allowed"], false);
    }
}
