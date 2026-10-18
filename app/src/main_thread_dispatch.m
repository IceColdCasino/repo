#import <dispatch/dispatch.h>
#import <pthread.h>
#import <dlfcn.h>
#import <string.h>
#import <TargetConditionals.h>
#if TARGET_OS_IPHONE
#import <os/log.h>
#else
#import <Foundation/Foundation.h>
#endif

#if !TARGET_OS_IPHONE
#import <IOKit/pwr_mgt/IOPMLib.h>

/// Keep WKWebView timers alive during dual-window E2E (macOS App Nap freezes JS).
/// Must CFRetain: this .m is compiled without ARC, so the autoreleased token
/// would otherwise die immediately and App Nap returns (ps state "N").
static id g_zkpoker_app_nap_activity = nil;
static IOPMAssertionID g_zkpoker_pm_assertion = kIOPMNullAssertionID;

void zkpoker_disable_app_nap(void) {
    @autoreleasepool {
        if (!g_zkpoker_app_nap_activity) {
            id activity = [[NSProcessInfo processInfo]
                beginActivityWithOptions:(NSActivityUserInitiated
                    | NSActivityLatencyCritical
                    | NSActivityIdleSystemSleepDisabled
                    | NSActivitySuddenTerminationDisabled
                    | NSActivityAutomaticTerminationDisabled)
                                  reason:@"zk-poker native gameplay / E2E"];
            if (activity) {
                g_zkpoker_app_nap_activity = activity; // ARC retains static
            }
        }
        if (g_zkpoker_pm_assertion == kIOPMNullAssertionID) {
            IOPMAssertionCreateWithName(
                kIOPMAssertionTypeNoDisplaySleep,
                kIOPMAssertionLevelOn,
                CFSTR("zk-poker native E2E"),
                &g_zkpoker_pm_assertion);
        }
        // Also disable App Nap via the legacy defaults key for this process.
        [[NSUserDefaults standardUserDefaults] setBool:YES forKey:@"NSAppSleepDisabled"];
        NSLog(@"[zk-poker] App Nap disabled (activity=%p pm=%u)",
            g_zkpoker_app_nap_activity, (unsigned)g_zkpoker_pm_assertion);
    }
}
#else
void zkpoker_disable_app_nap(void) {}
#endif

void zkpoker_ios_log_line(const char *message) {
#if TARGET_OS_IPHONE
    os_log(OS_LOG_DEFAULT, "%{public}s", message);
#else
    (void)message;
#endif
}

void *zkpoker_ios_dlopen(const char *path, char *err_out, size_t err_len) {
    dlerror();
    void *handle = dlopen(path, RTLD_LAZY | RTLD_LOCAL);
    if (!handle) {
        const char *err = dlerror();
        if (err && err_out && err_len > 0) {
            size_t n = strlen(err);
            if (n >= err_len) n = err_len - 1;
            memcpy(err_out, err, n);
            err_out[n] = '\0';
        }
        return NULL;
    }
    return handle;
}

void *zkpoker_ios_dlsym(void *handle, const char *symbol) {
    return dlsym(handle, symbol);
}

void zkpoker_ios_dlclose(void *handle) {
    if (handle) {
        dlclose(handle);
    }
}

void zkpoker_dispatch_on_main(void (*fn)(void *), void *ctx) {
#if TARGET_OS_IPHONE
    // Native iOS E2E polls bridge responses on the main thread. Sync delivery
    // never runs while the main queue is blocked unless we sync here.
    if (pthread_main_np()) {
        fn(ctx);
        return;
    }
    dispatch_sync_f(dispatch_get_main_queue(), ctx, (dispatch_function_t)fn);
#else
    if (pthread_main_np()) {
        fn(ctx);
        return;
    }
    dispatch_async_f(dispatch_get_main_queue(), ctx, (dispatch_function_t)fn);
#endif
}

void zkpoker_dispatch_on_main_sync(void (*fn)(void *), void *ctx) {
    if (pthread_main_np()) {
        fn(ctx);
        return;
    }
    dispatch_sync_f(dispatch_get_main_queue(), ctx, (dispatch_function_t)fn);
}
