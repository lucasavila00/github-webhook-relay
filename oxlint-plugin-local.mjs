const getTypeNode = (typeAnnotation) => {
  if (typeAnnotation == null) return null;
  const typeNode = typeAnnotation.type === "TSTypeAnnotation"
    ? typeAnnotation.typeAnnotation
    : typeAnnotation;
  return typeNode.type === "TSParenthesizedType" ? getTypeNode(typeNode.typeAnnotation) : typeNode;
};

const hasType = (types, type) => types.some((unionType) => getTypeNode(unionType)?.type === type);

const noIncompleteNullishTypes = {
  meta: {
    type: "problem",
    messages: {
      incomplete: "Include both `null` and `undefined` in the nullish type.",
      optional: "Use a required declaration with `T | null | undefined`.",
      standalone: "Use `null | undefined` when a type permits a nullish value.",
    },
    schema: [],
  },
  create(context) {
    const checkOptional = (node) => {
      if (node.optional) context.report({ node, messageId: "optional" });
    };
    return {
      Identifier: checkOptional,
      ArrayPattern: checkOptional,
      ObjectPattern: checkOptional,
      PropertyDefinition: checkOptional,
      TSMethodSignature: checkOptional,
      TSMappedType: checkOptional,
      TSNamedTupleMember: checkOptional,
      TSOptionalType(node) {
        context.report({ node, messageId: "optional" });
      },
      TSPropertySignature: checkOptional,
      TSNullKeyword(node) {
        if (node.parent.type !== "TSUnionType") {
          context.report({ node, messageId: "standalone" });
        }
      },
      TSUndefinedKeyword(node) {
        if (node.parent.type !== "TSUnionType") {
          context.report({ node, messageId: "standalone" });
        }
      },
      TSUnionType(node) {
        const hasNull = hasType(node.types, "TSNullKeyword");
        const hasUndefined = hasType(node.types, "TSUndefinedKeyword");
        if (hasNull !== hasUndefined) context.report({ node, messageId: "incomplete" });
      },
    };
  },
};

const isNullish = (node) =>
  (node.type === "Literal" && node.value == null) ||
  (node.type === "Identifier" && node.name === "undefined");

const noStrictNullishComparison = {
  meta: {
    type: "problem",
    messages: { check: "Use a loose comparison for a nullish check." },
    schema: [],
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (
          (node.operator === "===" || node.operator === "!==") &&
          (isNullish(node.left) || isNullish(node.right))
        ) context.report({ node, messageId: "check" });
      },
    };
  },
};

const noNullishCoalesceNoop = {
  meta: {
    type: "problem",
    messages: { noop: "Remove the nullish coalesce to a nullish value." },
    schema: [],
  },
  create(context) {
    return {
      LogicalExpression(node) {
        if (node.operator === "??" && isNullish(node.right)) {
          context.report({ node, messageId: "noop" });
        }
      },
    };
  },
};

export default {
  meta: { name: "local" },
  rules: {
    "no-incomplete-nullish-types": noIncompleteNullishTypes,
    "no-nullish-coalesce-noop": noNullishCoalesceNoop,
    "no-strict-nullish-comparison": noStrictNullishComparison,
  },
};
