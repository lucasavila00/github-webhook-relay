# Write business logic in tgo

Use `.tgo` files for business types and decisions. Use Go for the rest of the application.
Make each package either TGo or Go. Do not mix handwritten `.tgo` and `.go`
files in one package. Generated `*_tgo.go` files do not change a TGo package.
Keep Go imports and signatures. Compile with `tgo build ./...`, then run `go test ./...`
and `tgolint ./...`.
Commit each generated `*_tgo.go` file beside its source. Do not edit generated files.
Regenerate them after each source change.

The compiler parses TGo syntax and emits Go. `tgolint` checks source usage rules,
including explicit initialization, complete literals, named results, and invalid-zero
collection operations.
Ignore `.tgo.lock`. Do not replace it with a link.
Use Go build constraints and target suffixes on tgo files.
For example, `store_linux.tgo` emits `store_tgo_linux.go`.
Write tests for a TGo package in `_test.tgo` files. The compiler emits
`_tgo_test.go` files for the Go tool. Keep tests for a Go package in
`_test.go` files. Do not put TGo source in hidden, `_`, `testdata`, or
`vendor` paths.

## Sum types

Use an enum when each state needs different fields. Put each state's required data in its variant.

```text
type Account enum {
    Personal struct { Name string }
    Business struct { Company string; Members []Account }
}

func NewBusiness(company string) Account {
    return Account.Business{Company: company, Members: []Account{}}
}
```

Use a checked `switch value.Tag()` to read the active payload. Use `exhaustive:` to require every
declared variant, or use `default:` for fallback behavior. Read a payload only in its single-tag
case. A simple early-exit guard can also prove one tag. Every payload call or method value needs a
proof. The receiver root must belong to the current function. An assignment or writable escape
ends the proof. Do not use `fallthrough` or select generated enum methods through interfaces.
Control flow must not bypass the proof.
Type aliases can construct variants. Go name resolution selects the aliased type.
Do not shadow generated constructor, carrier, or default helper names at a construction.

```text
func Label(account Account) string {
    switch account.Tag() {
    case AccountTagPersonal: return account.PersonalPayload().Name
    case AccountTagBusiness: return account.BusinessPayload().Company
    exhaustive:
    }
}
```

## Checked structs

Add `checked` after a struct when a rule must run for each literal. Make all fields private and
define the exact value-receiver method `check() (T, error)`.

```text
type Quantity struct { value int } checked

func (value Quantity) check() (Quantity, error) {
    if value.value < 1 { return Quantity{}, ErrInvalidQuantity }
    return value,
}
```

Each literal returns `(Quantity, error)`. Use postfix `!` when the surrounding function returns an
error. The same literal form works from another TGo package. The compiler generates a fallible
`NewQuantity` ABI for Go callers, but TGo source cannot call it. It generates no field accessor.
TGo permits package-local field reads, but it rejects field changes and address-taking after
construction. On failure, the zero value is invalid.

## Error propagation

Use `call()!` for normal Go error propagation. The call must return values followed by `error`,
and the current function must end in `error`. The compiler adds the call name and wraps the cause.

```text
func Load(repo Repo, id ID) (Account, error) {
    account := repo.Find(id)!
    return account, nil
}
```

Use `call()!!` when the caller must return the same error value. This form adds no context and no
explicit allocation.

Use a normal error check when the caller must recover, classify the error, add runtime data, or
return a different value.

## Initialization and defaults

Initialize each variable. Supply every struct field, or select declared defaults with `..default`.
Use defaults for optional construction data. Keep required business data explicit.
Go struct tags stay on generated fields.
Assign each named result before a read or bare return. A closure cannot establish this assignment.

```text
type Request struct {
    ID string
    Tags map[string]string = map[string]string{}
}

func NewRequest(id string) Request {
    return Request{ID: id, ..default}
}
```

A selected map or slice literal makes fresh storage. A reference default keeps its alias.
A supplied field skips its default. Explicit fields run first, then selected defaults in field order.
Defaults also work on enum payload fields.
Struct copies share reference data. Do not assume a deep copy.

## Collections

Use a comprehension for one eager slice or map result. Keep ranges and filters as one nested path.

```text
names := []string{for _, account := range accounts {
    if account.Active { account.Name }
}}
```

Use `key: value` for a map result. Use a Go loop when the body mutates other data or needs control
statements. A comprehension emits direct fused loops and one result collection.

Start enum and checked-value slices with length zero. Append constructed values.
Do not zero-fill or clear their elements. Supply every index in array and slice literals.

```text
func Accounts(name string) []Account {
    accounts := make([]Account, 0, 4)
    return append(accounts, Account.Personal{Name: name})
}
```

For map values, channel values, and assertions whose zero is invalid, test presence first.
Use the bound value only in the successful branch.

```text
func Find(accounts map[string]Account, id string) string {
    if account, ok := accounts[id]; ok {
        return Label(account)
    }
    return "missing"
}
```

Use the same form for `if account, ok := <-channel; ok` and `if account, ok := input.(Account); ok`.
A source guard can permit shortening a slice: `if n <= len(accounts) { use(accounts[:n]) }`.
Do not change the bound or slice before the read. Unproven bounds fail at compile time.
Map `clear` removes entries and is allowed. Native `copy` keeps Go overlap behavior.

## Go callers and tests

Go calls use the original Go types. A checked-struct constructor runs `check`. Reads and other Go
calls do not add boundary validation. Keep named Go types, callbacks, interfaces, channels,
pointers, variadic calls, generic calls, and typed nil behavior.

```go
quantity, err := model.NewQuantity(3)
if err != nil {
    return err
}
account := model.NewAccountPersonal("Lucas")
```

`NewQuantity` in this example is generated Go ABI. Test check success and failure, every tag
branch, and shared collection changes.
Test calls in both directions. Include Go error results and invalid foreign values. Run
`tgolint` to check Go construction, result pairs, and enum access.

## Go boundary

TGo trusts values from Go. Do not expect a runtime validator. Go code must follow the generated
constructor and accessor rules. Use `tgolint` for the Go patterns that it can check.
