# Bootstrap Metadata

The `wdyt` browser extension is coordinated through visits to:

```text
/bootstrap?action=start
/bootstrap?action=finalize
```

Only `action` is required.

## Supported Query Parameters

- required:
  - `action`
    - `start`
    - `finalize`
- optional:
  - `serverUrl`
  - `suiteName`
  - `testName`
  - `tool`
  - `reason`

## Examples

Minimal start:

```text
/bootstrap?action=start
```

Minimal finalize:

```text
/bootstrap?action=finalize
```

With additional metadata:

```text
/bootstrap?action=start&suiteName=checkout&testName=guest-checkout&tool=playwright
```

Finalize with timeout reason:

```text
/bootstrap?action=finalize&reason=timeout
```

## Current Defaults

If optional metadata is omitted:

- `serverUrl`
  - defaults to the bootstrap request origin
- `suiteName`
  - defaults internally to `unknown-suite`
- `testName`
  - defaults internally to `unnamed-test`
- browser metadata
  - is inferred from the bootstrap request by the server when possible

## Practical Guidance

Recommended order:

1. start with only `action=start` and `action=finalize`
2. confirm capture works end-to-end
3. add `suiteName`, `testName`, and `tool` once the base handshake is stable

That keeps the initial wiring simple and makes it easier to isolate extension-loading or bootstrap issues before layering in extra metadata.
