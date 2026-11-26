import assert from "node:assert/strict";
import { Client, SequenceAllocator } from "ml-collab-codec";

export function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.value;
}

export function object(properties = {}, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false };
}

export function component(props, allowedTags) {
  return {
    identity: "stable",
    props,
    content: allowedTags === undefined ? { mode: "none" } : { mode: "element", allowedTags },
  };
}

export function join(authority, actor) {
  return new Client({
    ...authority.scope(),
    actor,
    allocator: SequenceAllocator.ephemeral(actor),
    table: authority.getTable(),
    revision: authority.getRevision(),
  });
}

export function submit(authority, client, peers = []) {
  const request = client.nextRequest();
  assert.ok(request);
  const decision = authority.submit(request, { actor: client.options.actor });
  assert.equal(decision.kind, "decided");
  if (decision.transition !== undefined)
    for (const peer of [client, ...peers]) peer.receive(decision.transition);
  client.receive(decision.receipt);
  return decision.receipt;
}
