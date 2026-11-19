#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <node_api.h>

/* Resolve Node-API from the embedding module (Node.exe or Owl's chrome.dll).
 * Linking node.lib directly would bind the addon to node.exe instead. */
static napi_status (NAPI_CDECL *create_function)(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
static napi_status (NAPI_CDECL *set_property)(napi_env, napi_value, const char *, napi_value);
static napi_status (NAPI_CDECL *create_object)(napi_env, napi_value *);
static napi_status (NAPI_CDECL *create_string)(napi_env, const char16_t *, size_t, napi_value *);
static napi_status (NAPI_CDECL *create_number)(napi_env, uint32_t, napi_value *);
static napi_status (NAPI_CDECL *get_boolean)(napi_env, bool, napi_value *);
static napi_status (NAPI_CDECL *get_null)(napi_env, napi_value *);
static napi_status (NAPI_CDECL *get_undefined)(napi_env, napi_value *);
static napi_status (NAPI_CDECL *throw_error)(napi_env, const char *, const char *);

__declspec(dllexport) HRESULT codexdc_unregister_restart(void) {
  return UnregisterApplicationRestart();
}

static napi_value fail(napi_env env, const char *operation, HRESULT result) {
  char message[160];
  snprintf(message, sizeof(message), "%s failed (HRESULT 0x%08lX)", operation, (unsigned long)result);
  throw_error(env, NULL, message);
  return NULL;
}

static napi_value unregister_restart(napi_env env, napi_callback_info info) {
  (void)info;
  HRESULT result = codexdc_unregister_restart();
  if (FAILED(result)) return fail(env, "UnregisterApplicationRestart", result);
  napi_value value;
  get_undefined(env, &value);
  return value;
}

static napi_value get_registration(napi_env env, napi_callback_info info) {
  (void)info;
  WCHAR command[RESTART_MAX_CMD_LINE + 1];
  DWORD size = ARRAYSIZE(command), flags = 0;
  HRESULT result = GetApplicationRestartSettings(GetCurrentProcess(), command, &size, &flags);
  napi_value value, arguments, number;
  if (result == HRESULT_FROM_WIN32(ERROR_NOT_FOUND)) {
    get_null(env, &value);
    return value;
  }
  if (FAILED(result)) return fail(env, "GetApplicationRestartSettings", result);
  create_object(env, &value);
  create_string(env, (const char16_t *)command, NAPI_AUTO_LENGTH, &arguments);
  create_number(env, flags, &number);
  set_property(env, value, "arguments", arguments);
  set_property(env, value, "flags", number);
  return value;
}

static napi_value is_process_elevated(napi_env env, napi_callback_info info) {
  (void)info;
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    return fail(env, "OpenProcessToken", HRESULT_FROM_WIN32(GetLastError()));
  }
  TOKEN_ELEVATION elevation;
  DWORD size;
  BOOL ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  CloseHandle(token);
  if (!ok) return fail(env, "GetTokenInformation", HRESULT_FROM_WIN32(error));

  napi_value value;
  get_boolean(env, elevation.TokenIsElevated != 0, &value);
  return value;
}

NAPI_MODULE_INIT() {
  HMODULE host = GetModuleHandleW(L"chrome.dll");
  if (!host) host = GetModuleHandleW(NULL);
#define RESOLVE(target, name) *(FARPROC *)&target = GetProcAddress(host, name); if (!target) return NULL
  RESOLVE(create_function, "napi_create_function");
  RESOLVE(set_property, "napi_set_named_property");
  RESOLVE(create_object, "napi_create_object");
  RESOLVE(create_string, "napi_create_string_utf16");
  RESOLVE(create_number, "napi_create_uint32");
  RESOLVE(get_boolean, "napi_get_boolean");
  RESOLVE(get_null, "napi_get_null");
  RESOLVE(get_undefined, "napi_get_undefined");
  RESOLVE(throw_error, "napi_throw_error");
#undef RESOLVE
  napi_value function;
  create_function(env, "unregisterRestart", NAPI_AUTO_LENGTH, unregister_restart, NULL, &function);
  set_property(env, exports, "unregisterRestart", function);
  create_function(env, "getRestartRegistration", NAPI_AUTO_LENGTH, get_registration, NULL, &function);
  set_property(env, exports, "getRestartRegistration", function);
  create_function(env, "isProcessElevated", NAPI_AUTO_LENGTH, is_process_elevated, NULL, &function);
  set_property(env, exports, "isProcessElevated", function);
  return exports;
}
