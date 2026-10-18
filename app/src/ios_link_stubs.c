// Stubs for symbols Zig pulls in on Darwin but that are unavailable or
// optional on iOS simulator static links.
#include <stddef.h>

void *_dyld_get_image_header_containing_address(const void *addr) {
    (void)addr;
    return NULL;
}
