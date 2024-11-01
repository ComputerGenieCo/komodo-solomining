#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

/*
Contributed by Alex Petrov aka SysMan at sysman.net
Updated by Alejandro Reyero - TodoJuegos.com
Part of NOMP project
Simple lightweight & fast - a more efficient block notify script in pure C.
Platforms : Linux, BSD, Solaris (mostly OS independent)
Build with:
    gcc blocknotify.c -o blocknotify
Example usage in daemon coin.conf using default NOMP CLI port of 17117
    blocknotify="/bin/blocknotify 127.0.0.1:17117 dogecoin %s"
*/

#define BUFFER_SIZE 1000
#define HOST_SIZE 200

void print_usage() {
    printf("Block notify\n usage: <host:port> <coin> <block>\n");
}

int main(int argc, char **argv) {
    if (argc < 4) {
        print_usage();
        return EXIT_FAILURE;
    }

    int sockfd;
    struct sockaddr_in servaddr;
    char sendline[BUFFER_SIZE];
    char host[HOST_SIZE];
    char *port_str;
    int port;

    strncpy(host, argv[1], HOST_SIZE - 1);
    host[HOST_SIZE - 1] = '\0'; // Ensure null-termination

    port_str = strchr(host, ':');
    if (!port_str) {
        fprintf(stderr, "Invalid host:port format\n");
        return EXIT_FAILURE;
    }

    *port_str = '\0';
    port_str++;
    errno = 0;
    port = strtol(port_str, NULL, 10);
    if (errno != 0) {
        perror("Invalid port number");
        return EXIT_FAILURE;
    }

    snprintf(sendline, sizeof(sendline), "{\"command\":\"blocknotify\",\"params\":[\"%s\",\"%s\"]}\n", argv[2], argv[3]);

    sockfd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sockfd < 0) {
        perror("Socket creation failed");
        return EXIT_FAILURE;
    }

    memset(&servaddr, 0, sizeof(servaddr));
    servaddr.sin_family = AF_INET;
    servaddr.sin_addr.s_addr = inet_addr(host);
    servaddr.sin_port = htons(port);

    if (connect(sockfd, (struct sockaddr *)&servaddr, sizeof(servaddr)) < 0) {
        perror("Connection failed");
        close(sockfd);
        return EXIT_FAILURE;
    }

    if (send(sockfd, sendline, strlen(sendline), 0) < 0) {
        perror("Send failed");
        close(sockfd);
        return EXIT_FAILURE;
    }

    close(sockfd);
    return EXIT_SUCCESS;
}
