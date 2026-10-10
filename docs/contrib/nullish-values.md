# Nullish values

Application code uses one absent-value model. Treat `null`, `undefined`, and a
missing object property as equivalent forms of an absent value.

Declare a nullable property with both nullish types:

```ts
type Example = Readonly<{
  foo: string | null | undefined;
}>;
```

For this Beff schema, the generated validator accepts `{ foo: null }`,
`{ foo: undefined }`, and a wire object with no `foo` property. The required
TypeScript property does not make the wire property required. This behavior
applies to nullable schema properties. It does not make non-nullable schemas
accept nullish values.

Do not declare application properties or parameters with `?`. Make them
required and include both `null` and `undefined` in the type. Do not use a
conditional object spread only to remove a property that has an `undefined`
value. Pass the property directly:

```ts
const value: Example = { foo };
```

Keep an external library contract exact when the library distinguishes the
values. For example, a SQL binding can require a null-only value. Document such
exceptions where the code uses them.
