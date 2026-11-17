/** registry 증명 묶음 — 9.1 실측 모양(publish 증명 + SLSA provenance) 그대로. */
export function attestationBundle(version: string, workflow = { repository: "https://github.com/codelives/ainecto", path: ".github/workflows/publish.yml" }) {
  const statement = (predicateType: string, predicate: unknown) => ({
    predicateType,
    bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify({
      subject: [{ name: `pkg:npm/%40ainecto/mcp@${version}`, digest: { sha512: "x" } }], predicate,
    })).toString("base64") } },
  });
  return {
    attestations: [
      statement("https://github.com/npm/attestation/tree/main/specs/publish/v0.1", { name: "@ainecto/mcp", version }),
      statement("https://slsa.dev/provenance/v1", { buildDefinition: { externalParameters: { workflow: { ref: "refs/heads/x", ...workflow } } } }),
    ],
  };
}
