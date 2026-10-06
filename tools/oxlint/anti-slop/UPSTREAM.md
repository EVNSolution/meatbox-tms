# Anti Slop provenance

- Upstream: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- License: MIT; preserved in `LICENSE`.
- Scope: only the four reviewed generic rules and their required shared helpers are vendored. The Effect rule group and all other rules are excluded.
- `src/selected-plugin.ts` and local package metadata are Meatbox adapters and are not upstream files.

The following SHA-256 values are for the exact upstream bytes copied into this directory:

```text
10ed33bf340d6d63dc0633dfc917a346b369b6aa41fe20734aefc6a3fb75ba17  LICENSE
528bba857b84712c038e35e59079cc1e6c78a0421c65bb3c6117c9d412a2f28a  src/rules/no-array-filter-map.ts
dce4b08ee7ac4bbedfe743f6fa4a3d423cde50b37691130b899cc4573c05d2ae  src/rules/no-reduce-accumulator-copy.ts
f7920a332106252d6a24cdc917a2c1a433eb438792996ccceb5a25cd6e591dbb  src/rules/no-reflect-apply.ts
95c5aa0f8e23b10d9345b1776082e08704ec6590298176a8ede8dfdb6e7cb56f  src/rules/no-reflect-get.ts
e360557253c56ab7c256623f3338415743e5027e9d999f801fb79d98240d217b  src/shared/array-method.ts
d1b7bd13ca714bf20bec15e835ed0526316b7274e06bd9a582cf623c09ac1d40  src/shared/reflect-method.ts
e38d41eeada854dbd02285e84e065d10e69460695e06e53fbe8662c963ae7eb4  src/shared/scope.ts
```
