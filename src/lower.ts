/**
 * MM — AST → HIR lowering.
 *
 * Assigns every definition a stable, session-local integer id and normalizes item
 * structure so downstream passes never walk `use` trees or re-derive visibility.
 * Ids are session-local aliases only (kernel.md §7.1): the *stable* identity is the
 * content hash computed by the semantic graph, never this number.
 *
 * See docs/spec/kernel.md §2, §7.
 */

import type {
  Attribute, Block, Diagnostic, Expr, FieldDecl, FnItem, LoweredField, LoweredFn,
  LoweredParam, Ownership, SourceFile, Span, TypeExpr, TypeParam, UseTree, VariantDecl,
} from "./ast.ts";
import { parseFile } from "./parser.ts";

/** A unique source of ids for one lowering session. */
export class IdGen {
  private next = 0;
  take(): number {
    return this.next++;
  }
  peek(): number {
    return this.next;
  }
}

export interface LoweredTypeDecl {
  kind: "type";
  id: number;
  def: LoweredTypeDeclDef;
  attrs: Attribute[];
  visibility: "pub" | "priv";
  module: string;
  span: Span;
  nameSpan: Span;
}

export type LoweredTypeDeclDef =
  | { form: "record"; name: string; generics: TypeParam[]; fields: LoweredField[] }
  | {
      form: "union";
      name: string;
      generics: TypeParam[];
      variants: Array<Omit<VariantDecl, "fields"> & { fields: LoweredField[] }>;
    }
  | { form: "choice"; name: string; generics: TypeParam[]; choices: string[] }
  | { form: "alias"; name: string; generics: TypeParam[]; target: TypeExpr };

export interface LoweredTrait {
  kind: "trait";
  id: number;
  name: string;
  module: string;
  generics: TypeParam[];
  methods: LoweredFn[];
  attrs: Attribute[];
  visibility: "pub" | "priv";
  span: Span;
  nameSpan: Span;
}

export interface LoweredImpl {
  kind: "impl";
  id: number;
  trait: string;
  typeName: string;
  module: string;
  generics: TypeParam[];
  methods: LoweredFn[];
  attrs: Attribute[];
  span: Span;
}

export interface LoweredConst {
  kind: "const";
  id: number;
  name: string;
  module: string;
  ty: TypeExpr | null;
  value: Block | Expr;
  attrs: Attribute[];
  visibility: "pub" | "priv";
  /** `const fn f(..) { .. }` stores a block; `const X: T = e` stores an expression. */
  isConstFn: boolean;
  span: Span;
  nameSpan: Span;
}

export interface LoweredTest {
  kind: "test";
  id: number;
  name: string;
  body: Block;
  module: string;
  attrs: Attribute[];
  span: Span;
  nameSpan: Span;
}

export interface LoweredUse {
  kind: "use";
  tree: UseTree;
  span: Span;
}

/** Everything lowering produced for one file. */
export interface LoweredUnit {
  file: SourceFile;
  fileIndex: number;
  module: string;
  types: LoweredTypeDecl[];
  fns: LoweredFn[];
  traits: LoweredTrait[];
  impls: LoweredImpl[];
  consts: LoweredConst[];
  tests: LoweredTest[];
  uses: LoweredUse[];
  /** Ids of fns that are trait or impl methods: a method name may legally repeat. */
  methodIds: Set<number>;
  diagnostics: Diagnostic[];
}

/** Extracts the ownership discipline written on a type expression (kernel.md §3.4). */
export function ownershipOf(ty: TypeExpr): Ownership {
  if (ty.kind === "own") return ty.ownership;
  return "owned";
}

export function lowerFile(source: SourceFile, fileIndex: number, ids: IdGen): LoweredUnit {
  const parsed = parseFile(source, fileIndex);
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  const unit: LoweredUnit = {
    file: source,
    fileIndex,
    module: source.module,
    types: [],
    fns: [],
    traits: [],
    impls: [],
    consts: [],
    tests: [],
    uses: [],
    methodIds: new Set(),
    diagnostics,
  };

  const lowerFields = (fields: readonly FieldDecl[]): LoweredField[] =>
    fields.map((f) => ({ ...f, typeRef: ids.take() }));

  const lowerFn = (fn: FnItem): LoweredFn => {
    const params: LoweredParam[] = fn.params.map((p) => ({
      name: p.name,
      ty: p.ty,
      attrs: p.attrs,
      span: p.span,
      id: ids.take(),
      ownership: ownershipOf(p.ty),
    }));
    const lowered: LoweredFn = {
      kind: "fn",
      id: ids.take(),
      name: fn.name,
      module: source.module,
      generics: fn.generics,
      params,
      ret: fn.ret ?? null,
      effects: fn.effects,
      body: fn.body,
      attrs: fn.attrs,
      visibility: fn.visibility,
      unsafety: fn.unsafety,
      externAbi: fn.externAbi,
      isConst: fn.isConst,
      span: fn.span,
      nameSpan: fn.nameSpan,
    };
    unit.fns.push(lowered);
    return lowered;
  };

  for (const item of parsed.items) {
    switch (item.kind) {
      case "use":
        unit.uses.push({ kind: "use", tree: item.tree, span: item.span });
        break;

      case "type": {
        const def = item.def;
        let loweredDef: LoweredTypeDeclDef;
        if (def.kind === "record") {
          loweredDef = { form: "record", name: def.name, generics: def.generics, fields: lowerFields(def.fields) };
        } else if (def.kind === "union") {
          loweredDef = {
            form: "union",
            name: def.name,
            generics: def.generics,
            variants: def.variants.map((v) => ({ ...v, fields: lowerFields(v.fields) })),
          };
        } else if (def.kind === "choice") {
          loweredDef = { form: "choice", name: def.name, generics: def.generics, choices: def.choices };
        } else {
          loweredDef = { form: "alias", name: def.name, generics: def.generics, target: def.target };
        }
        unit.types.push({
          kind: "type",
          id: ids.take(),
          def: loweredDef,
          attrs: item.attrs,
          visibility: item.visibility,
          module: source.module,
          span: item.span,
          nameSpan: def.nameSpan,
        });
        break;
      }

      case "fn":
        lowerFn(item);
        break;

      case "trait": {
        const methods = item.methods.map((m) => lowerFn(m));
        methods.forEach((m) => unit.methodIds.add(m.id));
        unit.traits.push({
          kind: "trait",
          id: ids.take(),
          name: item.name,
          module: source.module,
          generics: item.generics,
          methods,
          attrs: item.attrs,
          visibility: item.visibility,
          span: item.span,
          nameSpan: item.nameSpan,
        });
        break;
      }

      case "impl": {
        const methods = item.methods.map((m) => lowerFn(m));
        methods.forEach((m) => unit.methodIds.add(m.id));
        unit.impls.push({
          kind: "impl",
          id: ids.take(),
          trait: item.trait,
          typeName: item.typeName,
          module: source.module,
          generics: item.generics,
          methods,
          attrs: item.attrs,
          span: item.span,
        });
        break;
      }

      case "const": {
        unit.consts.push({
          kind: "const",
          id: ids.take(),
          name: item.name,
          module: source.module,
          ty: item.ty ?? null,
          value: item.value,
          attrs: item.attrs,
          visibility: item.visibility,
          isConstFn: item.value.kind === "block",
          span: item.span,
          nameSpan: item.nameSpan,
        });
        break;
      }

      case "test": {
        unit.tests.push({
          kind: "test",
          id: ids.take(),
          name: item.name,
          module: source.module,
          body: item.body,
          attrs: item.attrs,
          span: item.span,
          nameSpan: item.nameSpan,
        });
        break;
      }
    }
  }

  return unit;
}

// Re-exported so consumers depend on the lowered shape, not on the AST it came from.
export type { LoweredFn, LoweredParam } from "./ast.ts";
