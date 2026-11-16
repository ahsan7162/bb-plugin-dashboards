// The one check every dashboard save runs on the full program (after a patch is merged). It returns
// the problems as sentences for the agent; an empty list means the program may be stored.
import { createParser, tokenize, type ElementNode, type ParseResult } from "@openuidev/lang-core";
import { ROOT, SCHEMA } from "./generated";
import { MIN_REFRESH_SECONDS } from "./sources";

// lang-core's token kinds are a const enum it does not export at runtime. validate.test.ts pins
// these numbers against lang-core's tokenizer, so a renumbering fails the tests instead of this check.
export const T = { Newline: 0, LParen: 1, RParen: 2, LBrack: 3, RBrack: 4, LBrace: 5, RBrace: 6, Equals: 9, EOF: 13, Str: 14, Ident: 16, Type: 17, BuiltinCall: 35 } as const;

const parser = createParser(SCHEMA, ROOT);

/**
 * Problems with the program, or [] when it may be saved. `sources` are the dashboard's declared source names;
 * `floors` a higher minimum refresh interval by source name (script sources).
 */
export function validateProgram(program: string, sources: readonly string[], floors: Readonly<Record<string, number>> = {}): string[] {
  const result = parser.parse(program);
  return [...parseProblems(result), ...misplaced(result), ...tokenProblems(program, sources), ...intervalProblems(result, floors)];
}

const NO_TIMER = "leave it out to load only on open and when its arguments change";

/** A Query's refresh interval (its fourth argument), when given, is a number written in and not below its source's minimum. */
function intervalProblems(result: ParseResult, floors: Readonly<Record<string, number>>): string[] {
  return result.queryStatements.flatMap(({ statementId, toolAST, refreshAST }) => {
    if (refreshAST === null) return [];
    if (refreshAST.k !== "Num") return [`Query ${statementId}: the refresh interval must be a number of seconds written in, such as 60; ${NO_TIMER}.`];
    const source = toolAST?.k === "Str" ? toolAST.v : null;
    const floor = Math.max(MIN_REFRESH_SECONDS, (source !== null && floors[source]) || 0);
    const which = floor > MIN_REFRESH_SECONDS ? `the minimum for "${source}" (a script source) is ${floor}` : `the minimum is ${floor}`;
    if (refreshAST.v < floor) return [`Query ${statementId}: refreshes every ${refreshAST.v} seconds; ${which}. Use ${floor} or more, or ${NO_TIMER}.`];
    return [];
  });
}

function parseProblems(result: ParseResult): string[] {
  const problems = result.meta.errors.map((e) => `${e.code} in ${e.statementId ?? e.component}${e.path}: ${e.message}`);
  if (result.meta.incomplete) problems.push("The program is cut off: a bracket, parenthesis or string is not closed.");
  if (result.meta.unresolved.length > 0) problems.push(`Undefined names: ${result.meta.unresolved.join(", ")}.`);
  if (result.meta.orphaned.length > 0) problems.push(`Statements root does not reach (they would not render): ${result.meta.orphaned.join(", ")}.`);
  if (result.root?.typeName !== ROOT) problems.push(`The program needs a root statement: root = ${ROOT}([...]).`);
  return problems;
}

type Node = Record<string, unknown>;
const isObject = (v: unknown): v is Node => typeof v === "object" && v !== null;
const defs = SCHEMA.$defs as Record<string, { properties?: Record<string, Node> }>;

/** Component names a prop's schema accepts: a `$ref` or `anyOf` of `$ref`s, directly or as array items. Data props accept none. */
function slot(parent: string, prop: string): string[] {
  const schema = defs[parent]?.properties?.[prop];
  const inner = (schema?.type === "array" ? schema.items : schema) as Node | undefined;
  const options = (inner?.anyOf as Node[] | undefined) ?? [inner];
  return options.flatMap((o) => (typeof o?.$ref === "string" ? [o.$ref.split("/").pop()!] : []));
}

// Props that open a link; a written-in address there must be http or https. The components refuse
// any other scheme again when they render, which also covers addresses that come from data.
const LINKS: Record<string, string> = { LinkOut: "url", Record: "link" };

/** Only http and https; ui/components/bound.ts has the same check for rendering. */
function isWebUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

/**
 * Components outside the slots their parent's schema allows (the parser does not check this), and
 * written-in links that are not http or https. Parsed elements are walked, and so are components
 * written inside a ternary or @Each in a slot, which the parser leaves as AST nodes ({k: "Comp"}).
 * A component in a data prop is reported too.
 * shortcut: a name reference inside a ternary or @Each ({k: "Ref"}) is not followed, because its
 * statement is not in the parse result; such a child's slot is not checked.
 */
function misplaced(result: ParseResult): string[] {
  const found: string[] = [];
  const check = (name: string, where: string, allowed: string[], link: unknown) => {
    if (!allowed.includes(name)) found.push(`${name} cannot go in ${where}${allowed.length > 0 ? `; it takes ${allowed.join(" | ")}` : ", which takes data, not a component"}.`);
    if (typeof link === "string" && !isWebUrl(link)) found.push(`${name}.${LINKS[name]} "${link.slice(0, 60)}": only http and https links can open. Remove it or give the item's web address.`);
  };
  const walk = (value: unknown, where: string, allowed: string[]): void => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, where, allowed));
    if (!isObject(value)) return;
    if (value.type === "element") {
      const node = value as unknown as ElementNode;
      check(node.typeName, where, allowed, node.props[LINKS[node.typeName] ?? ""]);
      for (const [prop, child] of Object.entries(node.props)) walk(child, `${node.typeName}.${prop}`, slot(node.typeName, prop));
      return;
    }
    if (value.k === "Comp" && typeof value.name === "string" && value.name in defs) {
      const props = (value.mappedProps as Node | undefined) ?? {};
      const link = props[LINKS[value.name] ?? ""] as Node | undefined;
      check(value.name, where, allowed, link?.k === "Str" ? link.v : undefined);
      for (const [prop, child] of Object.entries(props)) walk(child, `${value.name}.${prop}`, slot(value.name, prop));
      return;
    }
    // A ternary, a builtin such as @Each, or a data object: whatever it yields fills the same slot.
    for (const child of Object.values(value)) walk(child, where, allowed);
  };
  if (result.root) for (const [prop, child] of Object.entries(result.root.props)) walk(child, `${result.root.typeName}.${prop}`, slot(result.root.typeName, prop));
  return found;
}

const HOW_TO_QUERY = 'write it as its own statement, name = Query("source", {args}, {defaults}, seconds), with the source name in quotes';

/**
 * Mutation, Query and protocol markers, found in the token stream: strings and comments are not
 * tokens, and the parse result misses a Mutation or Query inside a ternary, an object or @Each.
 * A Query (plain or @, which parse the same) passes only as a whole top-level statement,
 * `name = Query("source", ...)`, naming a declared source.
 */
function tokenProblems(program: string, sources: readonly string[]): string[] {
  const problems: string[] = [];
  const tokens = tokenize(program);
  let depth = 0;
  let statementStart = 0;
  let at = 0; // BuiltinCall tokens carry no offset; use the nearest earlier token that does
  tokens.forEach((token, i) => {
    at = token.start ?? at;
    const word = token.t === T.Type || token.t === T.BuiltinCall ? token.v : null; // `Name` or `@Name`
    if (word === "Mutation") {
      problems.push(`Mutation at line ${lineOf(program, at)}: dashboards are read-only, so a program cannot contain Mutation.`);
    } else if (word === "Query") {
      const line = lineOf(program, at);
      const name = tokens[i + 1]?.t === T.LParen && tokens[i + 2]?.t === T.Str ? String(tokens[i + 2]!.v) : null;
      const ownStatement = depth === 0 && i === statementStart + 2 && tokens[statementStart]?.t === T.Ident && tokens[statementStart + 1]?.t === T.Equals && endsStatement(tokens, i + 1);
      if (name === null || !ownStatement) problems.push(`Query at line ${line}: ${HOW_TO_QUERY}.`);
      else if (!sources.includes(name)) {
        const declared = sources.length === 0 ? "No sources are declared" : `Declared: ${sources.join(", ")}`;
        problems.push(`Query("${name}") at line ${line}: "${name}" is not a declared source. ${declared}. Declare it in dashboard_save's sources, or write the values into the program.`);
      }
    }
    if (token.t === T.LParen || token.t === T.LBrack || token.t === T.LBrace) depth++;
    if (token.t === T.RParen || token.t === T.RBrack || token.t === T.RBrace) depth = Math.max(0, depth - 1);
    if (token.t === T.Newline && depth === 0) statementStart = i + 1;
  });
  // Renderer renders only the last "]]>openui:content" section of a message, even one inside a
  // string here, so a marker would let it render text this check never saw.
  const marker = program.indexOf("]]>openui:");
  if (marker >= 0) problems.push(`Protocol marker "]]>openui:" at line ${lineOf(program, marker)}: remove it.`);
  return problems;
}

/** True when the call whose "(" is at `open` closes and nothing but the end of the line follows. */
function endsStatement(tokens: ReturnType<typeof tokenize>, open: number): boolean {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!.t;
    if (t === T.LParen || t === T.LBrack || t === T.LBrace) depth++;
    else if (t === T.RParen || t === T.RBrack || t === T.RBrace) depth--;
    if (depth === 0) return tokens[i + 1]?.t === T.Newline || tokens[i + 1]?.t === T.EOF;
  }
  return false;
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;
