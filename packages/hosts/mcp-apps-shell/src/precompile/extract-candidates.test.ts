import { describe, expect, it } from "@effect/vitest";
import { SKILLS } from "@executor-js/execution";

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

describe("skill examples", () => {
  const JSX_BLOCK = /```jsx\n([\s\S]*?)```/g;
  const CLASS_LITERAL = /className="([^"]*)"/g;

  const blocks = SKILLS.flatMap((skill) =>
    [...skill.body.matchAll(JSX_BLOCK)].map((match) => ({
      skill: skill.name,
      code: match[1] ?? "",
    })),
  );

  it("includes examples to check", () => {
    expect(blocks.length).toBeGreaterThan(5);
  });

  for (const [index, block] of blocks.entries()) {
    it(`offers every literal class in ${block.skill} example ${index + 1}`, () => {
      const candidates = new Set(extractCandidates(block.code));
      const classes = [...block.code.matchAll(CLASS_LITERAL)].flatMap((match) =>
        (match[1] ?? "").split(/\s+/).filter((token) => token.length > 0),
      );
      expect(classes.filter((token) => !candidates.has(token))).toEqual([]);
    });
  }
});
