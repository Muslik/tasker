# ui-kit workflow policy

Copy changes use the external translation workflow: extract keys, wait for translators, then pull
completed translations. Packages below `packages/@ott/` use a development publish for automated
checks and a human-owned final publication boundary before consumers update their version.
