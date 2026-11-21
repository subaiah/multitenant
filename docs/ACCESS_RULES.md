# Access rules

Roles decide what someone may do at all. Access rules can refuse it in some circumstances, such as outside working hours, from outside the office network, or for contractors, and make exceptions to those refusals. **A rule never grants what someone's roles don't.**

There are two levels:

- **The platform's rules** apply in every organization: Global policies → Access rules, `/platform/access-rules`.
- **An organization's own rules**: Security → Access rules, `/policies`.

The engine is in `backend/src/lib/access-rules.ts`, and it runs in the permission check (`middleware/authorize.ts`) after the roles allowed a request.

## How a request is decided

1. **The platform's rules**, highest priority first. The first that matches decides. `DENY` refuses. `ALLOW` lets the request past the platform's lower-priority rules.
2. **Then the organization's rules**, the same way.
3. If no rule matches, the request is allowed.

So an `ALLOW` rule is an exception to `DENY` rules *below it at the same level*. An organization can't make an exception to the platform's refusals.

A refusal answers `403` with `code: ACCESS_RULE_DENIED` and the rule's name and level. It is recorded in the organization's audit log as `access.denied_by_rule`.

Rules apply to an organization's people and its API keys (`user.type` is `API_KEY` for those). Platform staff aren't subject to them.

## A rule

```json
{
  "name": "No exports outside working hours",
  "effect": "DENY",
  "priority": 10,
  "conditions": {
    "actions": ["data-export:*", "audit:export"],
    "subjects": { "userTypes": ["TENANT_USER", "TENANT_MANAGER"] },
    "when": [
      { "attribute": "context.hour", "op": "between", "value": [19, 7] }
    ],
    "timezone": "Asia/Kolkata"
  }
}
```

| Part | Meaning |
| --- | --- |
| `actions` | The permissions it covers. Wildcards work: `billing:*`, or `*` for everything. Required. |
| `subjects` | Who it's about: `userTypes`, `roles` (names), `groups` (ids), `users` (ids). Each kind listed must match. With none listed, it covers everyone. |
| `when` | Conditions, all of which must hold. |
| `timezone` | For `context.hour`, `context.weekday` and `context.date`. Default UTC. |

An organization's rule can also have **bindings**:

- `TENANT`: the whole organization.
- `ORGANIZATION` / `ORG_UNIT`: people who belong to that organization or unit.
- `RESOURCE`: requests whose `:id` is that resource.

A rule without bindings applies to the whole organization.

### Attributes

| Attribute | Value |
| --- | --- |
| `user.id`, `user.type`, `user.email`, `user.emailDomain` | The person (or API key) |
| `user.roles`, `user.groups`, `user.units` | Lists: role names, group ids, organization and unit ids |
| `context.ip` | The request's address |
| `context.method`, `context.path` | The request |
| `context.apiKey` | `true` for API key requests |
| `context.hour` (0–23), `context.weekday` (`MON`…`SUN`), `context.date` (`YYYY-MM-DD`) | In the rule's time zone |
| `resource.type` | The permission's first part, e.g. `users` |
| `resource.id` | The request's `:id`, if it has one |

### Operators

- `eq`, `neq`: text compares ignoring case.
- `in`, `notIn`: the value is a list.
- `contains`, `notContains`: an item of a list attribute, or part of a text.
- `gte`, `lte`, `between`: numbers. `between` is inclusive, and wraps past midnight for hours (`[19, 7]`).
- `inCidr`, `notInCidr`: addresses or ranges, IPv4 or IPv6.
- `startsWith`, `endsWith`.
- `exists`, `notExists`.

## Trying a rule

Both pages have a **Try it** box: someone's email, a permission, and optionally an address and a time. It shows the decision and each rule's part. The same is available through the API: `POST /policies/evaluate` and `POST /platform/access-rules/evaluate`.

## Notes

- Rules are kept for 30 seconds per server. A change applies at once on the server that saved it.
- Rules saved before rules were enforced (`{ "action": …, "resource": … }`) don't match anything until edited.
