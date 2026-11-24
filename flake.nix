{
  description = "pi-knight: development shell and knight-tools package with the toolchain CI uses";

  # Same nixpkgs pin as roundtable-k8s/roundtable's flake.nix. nodejs_22 here is
  # 22.23.x, the 22 line that actions/setup-node@v4 (node-version: 22) and the
  # Dockerfile (node:22.19-slim) both run on.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/2786a2a72088ecf32aea5b3ec52099e6a7cff78f";

  outputs =
    { self, nixpkgs }:
    let
      # x86_64-darwin is not offered: nixpkgs 26.11 dropped it, so evaluating it throws.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # The single tool list, shared by devShells.default and packages.knight-tools
      # so the two cannot drift apart. npm ships with nodejs.
      devTools = pkgs: [
        pkgs.nodejs_22
        pkgs.git
        pkgs.gh
        pkgs.jq
      ];

      knightTools =
        pkgs:
        pkgs.buildEnv {
          name = "knight-tools";
          paths = devTools pkgs;
        };
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = devTools pkgs;
        };
      });

      # Installable as a knight tools image layer (spec.tools.flakes).
      packages = forAllSystems (pkgs: {
        knight-tools = knightTools pkgs;
      });

      # `nix flake check`: the package builds and exposes every tool on PATH.
      checks = forAllSystems (pkgs: {
        knight-tools = pkgs.runCommand "knight-tools-check" { } ''
          for bin in node npm npx git gh jq; do
            test -x ${knightTools pkgs}/bin/$bin || { echo "knight-tools: missing bin/$bin" >&2; exit 1; }
          done
          ${knightTools pkgs}/bin/node --version | grep -q '^v22\.'
          touch $out
        '';
      });
    };
}
