#ifndef ZERO_NATIVE_H
#define ZERO_NATIVE_H

#if defined(__STDDEF_H) || defined(_SIZE_T)
#include <stddef.h>
#include <stdint.h>
#else
typedef __SIZE_TYPE__ size_t;
typedef __UINTPTR_TYPE__ uintptr_t;
typedef __UINT64_TYPE__ uint64_t;
#endif

void *zero_native_app_create(void);
void zero_native_app_destroy(void *app);
void zero_native_app_start(void *app);
void zero_native_app_activate(void *app);
void zero_native_app_deactivate(void *app);
void zero_native_app_stop(void *app);
void zero_native_app_resize(void *app, float width, float height, float scale, void *surface);
void zero_native_app_touch(void *app, uint64_t id, int phase, float x, float y, float pressure);
void zero_native_app_command(void *app, const char *name, uintptr_t len);
void zero_native_app_frame(void *app);
void zero_native_app_set_asset_root(void *app, const char *path, uintptr_t len);
void zero_native_app_set_zkey_root(void *app, const char *path, uintptr_t len);
void zero_native_app_set_asset_entry(void *app, const char *path, uintptr_t len);
void zero_native_app_bridge_dispatch(void *app, const char *message, uintptr_t len);
size_t zero_native_app_take_bridge_response(void *app, char *out, size_t capacity);
int zero_native_app_loaded_source_kind(void *app);
size_t zero_native_app_loaded_asset_root(void *app, char *out, size_t capacity);
size_t zero_native_app_loaded_asset_entry(void *app, char *out, size_t capacity);
uintptr_t zero_native_app_last_command_count(void *app);
const char *zero_native_app_last_command_name(void *app);
const char *zero_native_app_last_error_name(void *app);

#endif
