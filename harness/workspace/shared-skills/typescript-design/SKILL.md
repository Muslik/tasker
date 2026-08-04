---
name: typescript-design
description: Apply the user's TypeScript design preferences — make invalid states unrepresentable, derive types from data instead of duplicating them, preserve literal types with satisfies, and guard untyped boundaries at runtime. Use when designing or reviewing TypeScript types, module APIs, config maps, discriminated unions, or generic helpers.
metadata:
  short-description: TypeScript type and API shape preferences
---

# TypeScript Design

Use this skill for TypeScript API shape, type modelling, review, and refactoring.

Apply root `AGENTS.md` coding rules first; this skill adds TypeScript-specific
guidance about the shape of types.

The single rule everything else serves: **make invalid states unrepresentable**.
A type that permits a combination the program cannot handle will eventually be
handed that combination. Prefer a compile error over a runtime assert, and a
runtime assert over a comment.

## Model States as Unions, Not Field Bags

- A group of fields that are meaningful only together belongs in one variant of a
  discriminated union, not in a flat object with optionals.
- Optional fields and booleans multiply states: `{ isLoading?: boolean; data?: T; error?: E }`
  admits sixteen combinations, of which three are real.
- Two booleans that cannot both be true are one union with two members.
- `flag?: boolean` has three states. If the third is not meaningful, make it required.

```ts
// admits { isLoading: true, error: E } and { data: T, error: E }
type Bad = { isLoading: boolean; data?: T; error?: E };

type Good =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'failed'; error: E };
```

Follow the discriminant the codebase already uses (`type` or `kind`) instead of
introducing a second convention — mixed discriminants defeat shared narrowing helpers.

## Construction Is Not the Type

- Fields absent only while an object is being built do not belong in the built
  type. Give the incomplete shape its own type, and let the constructor return
  the complete one.
- The result type should encode that required fields exist, instead of carrying
  optionals plus non-null assertions at every read site.
- Do not introduce a builder when all fields are already available.

## Derive Types From Data

- When a runtime object already lists the valid keys, derive the type from it:
  `keyof typeof MAP`. A hand-written union next to an object map is duplication
  that drifts silently — the map gains a key, the union does not, and nothing fails.
- Mapped and conditional types turn one source of truth into every view of it:
  the key union, the per-key payload, the per-key result.
- `[T] extends [never]` tests emptiness. Without the brackets the conditional
  distributes over the union and the check is wrong.

## Preserve Literal Types With `satisfies`

- A return type annotation both checks and **widens**. `satisfies` checks and
  **preserves**. If anything downstream derives types from the value, annotating
  it destroys that information — silently, since the code still compiles.
- Annotate when the type is the contract. Use `satisfies` when the value is the contract.

```ts
// action widens to string — per-entry inference is lost downstream
const make = (text: string): Config => ({ action: 'close', text });

// action stays 'close'
const make = (text: string) => ({ action: 'close', text }) satisfies Config;
```

This is the most expensive mistake in the file: nothing breaks at the definition,
the loss surfaces far away as a union that is suddenly too wide. Say in a comment
why the annotation is missing — otherwise it reads as an omission and gets "fixed".

## Open Unions Keep Their Autocomplete

- A value that must accept arbitrary strings from IO but also has well-known
  members: `type Code = 'A' | 'B' | (string & {})`. Plain `| string` collapses the
  union and the editor stops suggesting anything.

## Untyped Boundaries Are Guarded, Not Widened

- Data from the network, legacy JavaScript, or an untyped store arrives as
  `unknown`. Narrow it at the boundary with a type predicate.
- **Do not relax the internal contract to accommodate a caller.** Widening a
  parameter type so that one untyped call site compiles moves the problem into
  every other call site. Guard at the edge; keep the core total.
- `as` is not a guard — it silences the compiler without checking anything. Use it
  only after a real check, or when narrowing something you just constructed.
- Prefer `unknown` to `any`. `any` disables checking transitively.
- Avoid non-null `!`. If a value can be absent, either the type is wrong or a
  guard is missing.

```ts
const isKnown = (key: string): key is keyof typeof MAP => Object.hasOwn(MAP, key);
```

## Keep Heterogeneous Maps Homogeneous

- A map whose entries take different payloads cannot be typed entry-by-entry and
  stay assignable. Type the map with the payload narrowed to `never`, and express
  the key↔payload relation as a union at the call site.
- The map stays one type; the precision lives where it is used.

## Reusable Modules Are Typed By The Host

- A module that ships without knowing the application's domain declares an empty
  interface and lets the application fill it via `declare module`.
- The module stays portable, call sites stay typed, and nothing is cast.

## Generics And Signatures

- A type parameter that appears once is not a generic — it is `unknown` with extra syntax.
- Prefer a union parameter over overloads unless the return type genuinely depends
  on the argument.
- Mark public data `readonly` when the consumer has no business mutating it.
- Prefer a union of string literals over `enum`: no runtime artifact, no nominal
  surprises, better narrowing.

## Refactoring Bias

- Keep diffs minimal in existing code to reduce review churn.
- Preserve existing comments unless they are outdated.
- When fixing a typing issue, check whether it is a recurring pattern. If it likely
  exists elsewhere, ask the user before sweeping the codebase.
