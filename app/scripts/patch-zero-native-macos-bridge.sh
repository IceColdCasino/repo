#!/usr/bin/env bash
# Patch zero-native macOS bridge completion to deliver large JSON via base64 (same fix as iOS).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZERO_NATIVE="${1:-${ROOT}/../node_modules/zero-native}"
MARKER="zkpoker-bridge-b64-complete"

patch_file() {
  local file="$1"
  local kind="$2"
  if [[ ! -f "$file" ]]; then
    echo "[patch-zero-native] skip missing $file"
    return 0
  fi
  # Even when already patched, repair the historic %%@ bug (literal "%@" → hung invoke).
  if grep -q "atob('%%@')" "$file"; then
    python3 - "$file" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
text2 = text.replace("atob('%%@')", "atob('%@')")
if text2 != text:
    open(path, "w", encoding="utf-8").write(text2)
    print(f"[patch-zero-native] repaired %%@ -> %@ in {path}")
PY
  fi
  if grep -q "$MARKER" "$file"; then
    return 0
  fi

  python3 - "$file" "$kind" "$MARKER" <<'PY'
import re
import sys

path, kind, marker = sys.argv[1:4]
text = open(path, encoding="utf-8").read()

if kind == "appkit":
    pattern = (
        r"- \(void\)completeBridgeWithResponse:\(NSString \*\)response "
        r"windowId:\(uint64_t\)windowId webViewLabel:\(NSString \*\)webViewLabel \{"
        r".*?\n\}"
    )
    replacement = f'''- (void)completeBridgeWithResponse:(NSString *)response windowId:(uint64_t)windowId webViewLabel:(NSString *)webViewLabel {{
    // {marker}
    if (!pthread_main_np()) {{
        dispatch_async(dispatch_get_main_queue(), ^{{
            [self completeBridgeWithResponse:response windowId:windowId webViewLabel:webViewLabel];
        }});
        return;
    }}
    WKWebView *webView = [self webViewForWindowId:windowId];
    NSData *data = [(response.length > 0 ? response : @"{{}}") dataUsingEncoding:NSUTF8StringEncoding];
    if (!data) return;
    NSString *b64 = [data base64EncodedStringWithOptions:0];
    // IMPORTANT: use %@ (not %%@). %%@ becomes a literal "%@" and never inserts b64,
    // so window.zero._complete never runs and invoke('zk.prove') hangs until JS timeout.
    NSString *script = [NSString stringWithFormat:
        @"(function(){{try{{if(window.zero&&window.zero._complete){{window.zero._complete(JSON.parse(atob('%@')));}}}}catch(e){{console.error('[zero-native] bridge complete failed',e);}}}})();",
        b64];
    NSString *label = webViewLabel.length > 0 ? webViewLabel : @"main";
    if ([label isEqualToString:@"main"]) {{
        if (!webView) return;
        [webView evaluateJavaScript:script completionHandler:nil];
    }} else {{
        WKWebView *child = self.childWebViews[[self webViewKeyForWindow:windowId label:label]];
        if (!child) return;
        [child evaluateJavaScript:script completionHandler:nil];
    }}
    [self scheduleBridgeFrames];
}}'''
else:
    pattern = (
        r"- \(void\)completeBridgeWithResponse:\(NSString \*\)response "
        r"windowId:\(uint64_t\)windowId webViewLabel:\(NSString \*\)webViewLabel \{"
        r".*?\n\}"
    )
    replacement = f'''- (void)completeBridgeWithResponse:(NSString *)response windowId:(uint64_t)windowId webViewLabel:(NSString *)webViewLabel {{
    // {marker}
    CefRefPtr<CefBrowser> browser;
    NSString *label = webViewLabel.length > 0 ? webViewLabel : @"main";
    if ([label isEqualToString:@"main"] && self.browsers) {{
        auto it = self.browsers->find(windowId);
        if (it != self.browsers->end()) browser = it->second;
    }} else if (self.webviewBrowsers) {{
        std::string key = std::string([[self webViewKeyForWindow:windowId label:label] UTF8String]);
        auto it = self.webviewBrowsers->find(key);
        if (it != self.webviewBrowsers->end()) browser = it->second;
    }}
    if (!browser) return;
    CefRefPtr<CefFrame> frame = browser->GetMainFrame();
    if (!frame) return;
    NSData *data = [(response.length > 0 ? response : @"{{}}") dataUsingEncoding:NSUTF8StringEncoding];
    if (!data) return;
    NSString *b64 = [data base64EncodedStringWithOptions:0];
    // IMPORTANT: use %@ (not %%@) so b64 is substituted into the script.
    NSString *script = [NSString stringWithFormat:
        @"(function(){{try{{if(window.zero&&window.zero._complete){{window.zero._complete(JSON.parse(atob('%@')));}}}}catch(e){{console.error('[zero-native] bridge complete failed',e);}}}})();",
        b64];
    std::string scriptString(script.UTF8String);
    frame->ExecuteJavaScript(scriptString, frame->GetURL(), 0);
}}'''

new_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
if count != 1:
    print(f"[patch-zero-native] failed to patch {path} (matches={count})", file=sys.stderr)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(new_text)
print(f"[patch-zero-native] patched {path}")
PY
}

# Zig 0.17 removed the array-repeat operator. zero-native 0.2.0 still uses it.
python3 - "$ZERO_NATIVE" <<'PY'
import os
import re
import sys

root = sys.argv[1]
pattern = re.compile(r"var\s+([A-Za-z0-9_]+)\s*=\s*$")

def rewrite(text):
    out = []
    i = 0
    changed = 0
    while True:
        j = text.find("[_]", i)
        if j < 0:
            out.append(text[i:])
            break
        k = text.find("{", j)
        if k < 0:
            out.append(text[i:])
            break
        depth = 0
        end = None
        for p in range(k, len(text)):
            if text[p] == "{":
                depth += 1
            elif text[p] == "}":
                depth -= 1
                if depth == 0:
                    end = p
                    break
        if end is None:
            out.append(text[i:])
            break
        match = re.match(r"\s*\*\*\s*(\([^)]*\)|[A-Za-z0-9_\.]+)", text[end + 1:])
        if match is None:
            out.append(text[i:j + 3])
            i = j + 3
            continue
        init = text[k + 1:end].strip()
        count = match.group(1)
        prefix = text[i:j]
        declared = pattern.search(prefix)
        if declared:
            name = declared.group(1)
            ty = text[j + 3:k].strip()
            count_inner = count[1:-1] if count.startswith("(") else count
            out.append(text[i:i + declared.start()])
            out.append(f"var {name}: [{count_inner}]{ty} = @splat({init})")
        else:
            out.append(prefix)
            out.append(f"@splat({init})")
        changed += 1
        i = end + 1 + match.end()
    return "".join(out), changed

total = 0
for dirpath, _, names in os.walk(os.path.join(root, "src")):
    for name in names:
        if not name.endswith(".zig"):
            continue
        path = os.path.join(dirpath, name)
        text = open(path, encoding="utf-8").read()
        updated, count = rewrite(text)
        if count:
            open(path, "w", encoding="utf-8").write(updated)
            total += count
            print(f"[patch-zero-native] rewrote {count} array repeats in {path}")
if total == 0:
    print("[patch-zero-native] array repeats already rewritten")
PY
patch_file "${ZERO_NATIVE}/src/platform/macos/appkit_host.m" "appkit"
# Ensure pthread/dispatch imports for main-queue bridge completion.
python3 - "$ZERO_NATIVE/src/platform/macos/appkit_host.m" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
imports = "#import <dispatch/dispatch.h>\n#import <pthread.h>\n"
needle = "#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>\n"
if imports.strip() not in text and needle in text:
    text = text.replace(needle, needle + imports, 1)
    open(path, "w", encoding="utf-8").write(text)
    print(f"[patch-zero-native] added dispatch imports to {path}")
PY
patch_file "${ZERO_NATIVE}/src/platform/macos/cef_host.mm" "cef"
