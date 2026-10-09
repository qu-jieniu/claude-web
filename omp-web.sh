omp-attach() {
    if [ -x "$HOME/.containers/omp-web/omp-launcher" ]; then
        "$HOME/.containers/omp-web/omp-launcher" "$@"
    else
        /opt/omp-web/omp-launcher "$@"
    fi
}
