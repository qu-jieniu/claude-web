# Source from bashrc. Resolve symlinks so an installed bashrc.d link also works.
_omp_web_installed_root=$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")

omp-attach() {
    local launcher
    if [[ -n ${OMP_WEB_ROOT:-} ]]; then
        launcher=$OMP_WEB_ROOT/omp-launcher
    elif [[ -x $_omp_web_installed_root/omp-launcher ]]; then
        launcher=$_omp_web_installed_root/omp-launcher
    else
        launcher=/opt/omp-web/omp-launcher
    fi
    if [[ ! -x $launcher ]]; then
        printf 'omp-attach: launcher is not executable: %s\n' "$launcher" >&2
        return 127
    fi
    "$launcher" "$@"
}
