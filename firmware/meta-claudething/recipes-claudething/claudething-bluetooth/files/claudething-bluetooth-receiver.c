// SPDX-License-Identifier: MIT
// ClaudeThing authenticated RFCOMM snapshot receiver.

#define _GNU_SOURCE

#include <arpa/inet.h>
#include <bluetooth/bluetooth.h>
#include <bluetooth/rfcomm.h>
#include <errno.h>
#include <fcntl.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>

#define CLAUDETHING_RFCOMM_CHANNEL 22
#define CLAUDETHING_MAX_SNAPSHOT (1024U * 1024U)
#define CLAUDETHING_PREFIX_SIZE 20U
#define CLAUDETHING_DIGEST_SIZE 32U
#define CLAUDETHING_HEADER_SIZE (CLAUDETHING_PREFIX_SIZE + CLAUDETHING_DIGEST_SIZE)
#define CLAUDETHING_TOKEN_PATH "/var/lib/claudething/pairing.token"
#define CLAUDETHING_SNAPSHOT_PATH "/run/claudething-ui/snapshot.json"

static const unsigned char k_magic[8] = {'C', 'T', 'H', 'I', 'N', 'G', 'B', '1'};
static volatile sig_atomic_t g_stop = 0;

static void stop_handler(int signum) {
    (void)signum;
    g_stop = 1;
}

static uint64_t read_be64(const unsigned char *value) {
    uint64_t result = 0;
    for (size_t index = 0; index < 8; index++) result = (result << 8U) | value[index];
    return result;
}

static bool read_exact(int fd, unsigned char *buffer, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = recv(fd, buffer + offset, length - offset, 0);
        if (count == 0) return false;
        if (count < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        offset += (size_t)count;
    }
    return true;
}

static bool write_exact(int fd, const unsigned char *buffer, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = send(fd, buffer + offset, length - offset, MSG_NOSIGNAL);
        if (count == 0) return false;
        if (count < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        offset += (size_t)count;
    }
    return true;
}

static bool load_token(unsigned char **token, size_t *token_length) {
    int fd = open(CLAUDETHING_TOKEN_PATH, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return false;

    struct stat info;
    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size < 32 || info.st_size > 257) {
        close(fd);
        return false;
    }

    unsigned char *value = calloc((size_t)info.st_size + 1U, 1U);
    if (!value) {
        close(fd);
        return false;
    }
    ssize_t count = 0;
    while (count < info.st_size) {
        ssize_t portion = read(fd, value + count, (size_t)(info.st_size - count));
        if (portion == 0) break;
        if (portion < 0) {
            if (errno == EINTR) continue;
            count = -1;
            break;
        }
        count += portion;
    }
    close(fd);
    if (count != info.st_size) {
        OPENSSL_cleanse(value, (size_t)info.st_size + 1U);
        free(value);
        return false;
    }
    while (count > 0 && (value[count - 1] == '\n' || value[count - 1] == '\r')) count--;
    if (count < 32 || count > 256) {
        OPENSSL_cleanse(value, (size_t)info.st_size + 1U);
        free(value);
        return false;
    }
    for (ssize_t index = 0; index < count; index++) {
        unsigned char byte = value[index];
        if (!((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') ||
              (byte >= '0' && byte <= '9') || byte == '_' || byte == '-')) {
            OPENSSL_cleanse(value, (size_t)info.st_size + 1U);
            free(value);
            return false;
        }
    }
    *token = value;
    *token_length = (size_t)count;
    return true;
}

static bool authenticate(const unsigned char *header, const unsigned char *payload,
                         size_t payload_length, const unsigned char *token, size_t token_length) {
    unsigned char calculated[EVP_MAX_MD_SIZE];
    unsigned int calculated_length = 0;
    HMAC_CTX *context = HMAC_CTX_new();
    if (!context) return false;
    bool ok = HMAC_Init_ex(context, token, (int)token_length, EVP_sha256(), NULL) == 1 &&
              HMAC_Update(context, header, CLAUDETHING_PREFIX_SIZE) == 1 &&
              HMAC_Update(context, payload, payload_length) == 1 &&
              HMAC_Final(context, calculated, &calculated_length) == 1 &&
              calculated_length == CLAUDETHING_DIGEST_SIZE &&
              CRYPTO_memcmp(calculated, header + CLAUDETHING_PREFIX_SIZE,
                            CLAUDETHING_DIGEST_SIZE) == 0;
    HMAC_CTX_free(context);
    OPENSSL_cleanse(calculated, sizeof(calculated));
    return ok;
}

static bool valid_json_envelope(const unsigned char *payload, size_t length) {
    size_t first = 0;
    while (first < length && (payload[first] == ' ' || payload[first] == '\n' ||
                              payload[first] == '\r' || payload[first] == '\t')) first++;
    size_t last = length;
    while (last > first && (payload[last - 1] == ' ' || payload[last - 1] == '\n' ||
                            payload[last - 1] == '\r' || payload[last - 1] == '\t')) last--;
    return first < last && payload[first] == '{' && payload[last - 1] == '}' &&
           memchr(payload, '\0', length) == NULL;
}

static bool promote_snapshot(const unsigned char *payload, size_t length) {
    char temporary[] = "/run/claudething-ui/.snapshot.bluetooth.XXXXXX";
    int fd = mkstemp(temporary);
    if (fd < 0) return false;
    bool ok = fchmod(fd, 0600) == 0;
    size_t offset = 0;
    while (ok && offset < length) {
        ssize_t count = write(fd, payload + offset, length - offset);
        if (count < 0) {
            if (errno == EINTR) continue;
            ok = false;
            break;
        }
        offset += (size_t)count;
    }
    if (ok) ok = fsync(fd) == 0;
    if (close(fd) != 0) ok = false;
    if (ok) ok = rename(temporary, CLAUDETHING_SNAPSHOT_PATH) == 0;
    if (!ok) unlink(temporary);
    return ok;
}

static void sync_clock_from_sequence(uint64_t sequence) {
    uint64_t host_milliseconds = sequence / 1000U;
    // A signed snapshot may repair the battery-less device clock, but reject
    // nonsensical dates even when the envelope otherwise authenticates.
    if (host_milliseconds < 1704067200000ULL || host_milliseconds > 4102444800000ULL) return;
    struct timeval current;
    if (gettimeofday(&current, NULL) != 0) return;
    int64_t host_seconds = (int64_t)(host_milliseconds / 1000U);
    int64_t difference = host_seconds - (int64_t)current.tv_sec;
    if (difference >= -2 && difference <= 2) return;
    struct timeval corrected = {
        .tv_sec = (time_t)host_seconds,
        .tv_usec = (suseconds_t)((host_milliseconds % 1000U) * 1000U),
    };
    (void)settimeofday(&corrected, NULL);
}

static bool handle_client(int client, uint64_t *last_sequence) {
    struct timeval timeout = {.tv_sec = 10, .tv_usec = 0};
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));

    unsigned char header[CLAUDETHING_HEADER_SIZE];
    if (!read_exact(client, header, sizeof(header)) ||
        CRYPTO_memcmp(header, k_magic, sizeof(k_magic)) != 0) return false;

    uint32_t encoded_length = 0;
    memcpy(&encoded_length, header + 8, sizeof(encoded_length));
    size_t payload_length = (size_t)ntohl(encoded_length);
    uint64_t sequence = read_be64(header + 12);
    if (payload_length == 0 || payload_length > CLAUDETHING_MAX_SNAPSHOT ||
        sequence <= *last_sequence) return false;

    unsigned char *payload = malloc(payload_length);
    if (!payload) return false;
    bool ok = read_exact(client, payload, payload_length);

    unsigned char *token = NULL;
    size_t token_length = 0;
    if (ok) ok = load_token(&token, &token_length);
    if (ok) ok = authenticate(header, payload, payload_length, token, token_length);
    if (ok) ok = valid_json_envelope(payload, payload_length);
    if (ok) sync_clock_from_sequence(sequence);
    if (ok) ok = promote_snapshot(payload, payload_length);
    if (ok) *last_sequence = sequence;

    if (token) {
        OPENSSL_cleanse(token, token_length);
        free(token);
    }
    OPENSSL_cleanse(payload, payload_length);
    free(payload);

    static const unsigned char success[] = {'O', 'K', '1', '\n'};
    static const unsigned char failure[] = {'E', 'R', 'R', '\n'};
    (void)write_exact(client, ok ? success : failure, 4);
    return ok;
}

int main(void) {
    struct sigaction stop_action = {0};
    stop_action.sa_handler = stop_handler;
    sigemptyset(&stop_action.sa_mask);
    sigaction(SIGINT, &stop_action, NULL);
    sigaction(SIGTERM, &stop_action, NULL);
    signal(SIGPIPE, SIG_IGN);

    int listener = socket(AF_BLUETOOTH, SOCK_STREAM | SOCK_CLOEXEC, BTPROTO_RFCOMM);
    if (listener < 0) {
        perror("claudething-bluetooth: socket");
        return EXIT_FAILURE;
    }

    struct bt_security security = {.level = BT_SECURITY_MEDIUM, .key_size = 0};
    if (setsockopt(listener, SOL_BLUETOOTH, BT_SECURITY, &security, sizeof(security)) != 0) {
        perror("claudething-bluetooth: security");
        close(listener);
        return EXIT_FAILURE;
    }

    struct sockaddr_rc address = {0};
    address.rc_family = AF_BLUETOOTH;
    bacpy(&address.rc_bdaddr, BDADDR_ANY);
    address.rc_channel = CLAUDETHING_RFCOMM_CHANNEL;
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(listener, 1) != 0) {
        perror("claudething-bluetooth: listen");
        close(listener);
        return EXIT_FAILURE;
    }

    uint64_t last_sequence = 0;
    while (!g_stop) {
        int client = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
        if (client < 0) {
            if (g_stop) break;
            if (errno == EINTR) continue;
            perror("claudething-bluetooth: accept");
            sleep(1);
            continue;
        }
        (void)handle_client(client, &last_sequence);
        close(client);
    }
    close(listener);
    return EXIT_SUCCESS;
}
