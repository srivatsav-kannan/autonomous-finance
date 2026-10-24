import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";

const root = process.cwd();
function sources(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}
function dependencies(file: string) {
  const result: string[] = [];
  // The lockfile's TypeScript 7 scanner includes type-only imports and skips
  // comments. Unlike emitted JavaScript, it retains framework type coupling.
  const scanner = createScanner(true, LanguageVariant.Standard, readFileSync(resolve(root, file), "utf8"));
  const tokens: { kind: SyntaxKind; value: string }[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) tokens.push({ kind, value: scanner.getTokenValue() });
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1], beforePrevious = tokens[index - 2];
    if (token.kind === SyntaxKind.StringLiteral && (previous?.kind === SyntaxKind.FromKeyword || previous?.kind === SyntaxKind.ImportKeyword)) result.push(token.value);
    if (previous?.kind === SyntaxKind.OpenParenToken && (beforePrevious?.kind === SyntaxKind.ImportKeyword || beforePrevious?.value === "require")) {
      result.push(token.kind === SyntaxKind.StringLiteral ? token.value : "<nonliteral import>");
    }
  });
  return result.map(specifier => specifier.startsWith(".") ? relative(root, resolve(root, dirname(file), specifier)).replace(/\.js$/, ".ts") : specifier);
}

describe("payment module dependency boundaries", () => {
  it("keeps domain/contracts/ports free of framework, runtime, provider SDK and IO dependencies", () => {
    const files = [...sources("src/payments/domain"), ...sources("src/payments/ports"), "src/payments/contracts.ts", "src/integrations/contracts.ts"];
    expect(files.length).toBeGreaterThan(5);
    const violations = files.flatMap(file => dependencies(file).filter(dependency => !(
      dependency.startsWith("src/payments/domain/") || dependency.startsWith("src/payments/ports/") ||
      /^src\/payments\/contracts(?:\.ts)?$/.test(dependency) || /^src\/integrations\/contracts(?:\.ts)?$/.test(dependency) || dependency === "zod"
    )).map(dependency => `${file} -> ${dependency}`));
    expect(violations).toEqual([]);
  });

  it("makes application workflows depend on domain and ports rather than concrete adapters", () => {
    const files = sources("src/payments/application");
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap(file => dependencies(file).filter(dependency => !(
      dependency.startsWith("src/payments/application/") || dependency.startsWith("src/payments/domain/") ||
      dependency.startsWith("src/payments/ports/") || /^src\/payments\/contracts(?:\.ts)?$/.test(dependency)
    )).map(dependency => `${file} -> ${dependency}`));
    expect(violations).toEqual([]);
  });

  it("keeps transfer submission and service credentials out of ordinary agent entry points", () => {
    for (const file of ["src/payments/agents.ts", "src/agents/handlers/payments.ts"]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source).not.toMatch(/\.(?:createTransfer|submitPayment|settlePayment)\s*\(/);
      expect(source).not.toMatch(/AP_DISPATCH_SECRET|AP_EVIDENCE_SECRET|INCREASE_API_KEY/);
      expect(dependencies(file).filter(dependency => /integrations\/banking|payment-rail|payments\/dispatcher|payments\/evidence/.test(dependency))).toEqual([]);
    }
  });
});
