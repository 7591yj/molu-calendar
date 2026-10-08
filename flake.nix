{
  description = "MOLU dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachSystem [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ] (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs
            pnpm
          ];

          shellHook = ''
            echo "Node: $(node --version)"
            echo "pnpm: $(pnpm --version)"

            if [[ $- == *i* ]]; then
              exec ${pkgs.zsh}/bin/zsh
            fi
          '';
        };

        formatter = pkgs.nixfmt;
      }
    );
}
