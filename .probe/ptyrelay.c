#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <string.h>
#include <errno.h>

/* Relay: opens a PTY via /dev/pts/ptmx (the only ptmx reachable in this sandbox),
   reports the slave path on fd 3, forks the requested program onto the slave as
   its controlling terminal, and relays bytes between fd 0/1 and the master. */
int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: ptyrelay PROG [ARGS...]\n"); return 1; }
    int m = open("/dev/pts/ptmx", O_RDWR | O_NOCTTY);
    if (m < 0) { perror("open /dev/pts/ptmx"); return 2; }
    if (grantpt(m) < 0) { perror("grantpt"); return 3; }
    if (unlockpt(m) < 0) { perror("unlockpt"); return 4; }

    struct winsize ws;
    memset(&ws, 0, sizeof ws);
    ws.ws_row = 50; ws.ws_col = 140; ws.ws_xpixel = 0; ws.ws_ypixel = 0;
    ioctl(m, TIOCSWINSZ, &ws);

    char sp[256];
    if (ptsname_r(m, sp, sizeof sp) != 0) { perror("ptsname_r"); return 5; }
    write(3, sp, strlen(sp));
    write(3, "\n", 1);

    pid_t pid = fork();
    if (pid == 0) {
        close(m);
        setsid();
        int s = open(sp, O_RDWR); /* session leader: acquires ctty */
        if (s < 0) { perror("open slave"); _exit(6); }
        dup2(s, 0); dup2(s, 1); dup2(s, 2);
        if (s > 2) close(s);
        execvp(argv[1], argv + 1);
        perror("execvp");
        _exit(127);
    }

    fd_set r;
    char buf[16384];
    for (;;) {
        FD_ZERO(&r);
        FD_SET(0, &r);
        FD_SET(m, &r);
        int mx = (m > 0 ? m : 0) + 1;
        if (select(mx, &r, NULL, NULL, NULL) < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (FD_ISSET(0, &r)) {
            ssize_t k = read(0, buf, sizeof buf);
            if (k <= 0) break;
            if (write(m, buf, k) < 0) break;
        }
        if (FD_ISSET(m, &r)) {
            ssize_t k = read(m, buf, sizeof buf);
            if (k <= 0) break; /* EIO when the child exits */
            if (write(1, buf, k) < 0) break;
        }
    }
    int st;
    waitpid(pid, &st, WNOHANG);
    return 0;
}
