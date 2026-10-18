import { describe, expect, it } from "@effect/vitest";

import { extractCandidates, hasDynamicClassConstruction } from "./extract-candidates";

const SOURCE = `function App(){ const on = true; return (<div className={cn("p-4", on && "bg-muted")}>
 <div className="tracking-[0.08em] text-[11px] w-[calc(100%-2rem)] [&>*]:p-2 data-[state=open]:bg-accent md:grid-cols-4 content-['x'] bg-(--chart-1) *:rounded-md @md:flex">x</div>
 <span className={\`text-sm \${on ? "font-medium" : "font-normal"}\`}>y</span></div>); }`;

describe("extractCandidates", () => {
  const candidates = extractCandidates(SOURCE);

  for (const expected of [
    "tracking-[0.08em]",
    "text-[11px]",
    "w-[calc(100%-2rem)]",
    "[&>*]:p-2",
    "data-[state=open]:bg-accent",
    "md:grid-cols-4",
    "content-['x']",
    "bg-(--chart-1)",
    "*:rounded-md",
    "@md:flex",
    "p-4",
    "bg-muted",
    "text-sm",
    "font-medium",
    "font-normal",
  ]) {
    it(`finds ${expected}`, () => {
      expect(candidates).toContain(expected);
    });
  }
});

describe("hasDynamicClassConstruction", () => {
  for (const code of [
    "`bg-${c}-500`",
    "`w-[${n}px]`",
    "`grid-cols-${n}`",
    "`${tone}-500`",
    "`${bp}:flex`",
    'className={"bg-" + tone}',
    'className={tone + "-500"}',
  ]) {
    it(`flags ${code}`, () => {
      expect(hasDynamicClassConstruction(code)).toBe(true);
    });
  }

  for (const code of [
    "`${pct}%`",
    "`Item ${i}`",
    "`$${amount}`",
    '`text-sm ${on ? "font-medium" : "font-normal"}`',
    'className="p-4 text-sm"',
    'const label = "Total: " + total',
  ]) {
    it(`does not flag ${code}`, () => {
      expect(hasDynamicClassConstruction(code)).toBe(false);
    });
  }
});
