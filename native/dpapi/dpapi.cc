#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#include <node_api.h>

#include <cstring>

namespace {

void ThrowGeneric(napi_env env) {
  napi_throw_error(env, "ERR_DPAPI", "Windows credential protection failed");
}

bool ReadBuffer(napi_env env, napi_value value, BYTE** data, DWORD* length) {
  bool is_buffer = false;
  size_t size = 0;
  void* bytes = nullptr;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, value, &bytes, &size) != napi_ok || size > MAXDWORD) {
    napi_throw_type_error(env, "ERR_DPAPI_INPUT", "DPAPI input must be a Buffer");
    return false;
  }
  *data = static_cast<BYTE*>(bytes);
  *length = static_cast<DWORD>(size);
  return true;
}

napi_value Protect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    ThrowGeneric(env);
    return nullptr;
  }
  BYTE* bytes = nullptr;
  DWORD length = 0;
  if (!ReadBuffer(env, argv[0], &bytes, &length)) return nullptr;

  DATA_BLOB input = { length, bytes };
  DATA_BLOB output = { 0, nullptr };
  if (!CryptProtectData(&input, nullptr, nullptr, nullptr, nullptr,
                        CRYPTPROTECT_UI_FORBIDDEN, &output)) {
    ThrowGeneric(env);
    return nullptr;
  }

  napi_value result = nullptr;
  const napi_status status = napi_create_buffer_copy(env, output.cbData, output.pbData, nullptr, &result);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  if (status != napi_ok) {
    ThrowGeneric(env);
    return nullptr;
  }
  return result;
}

napi_value Unprotect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    ThrowGeneric(env);
    return nullptr;
  }
  BYTE* bytes = nullptr;
  DWORD length = 0;
  if (!ReadBuffer(env, argv[0], &bytes, &length)) return nullptr;

  DATA_BLOB input = { length, bytes };
  DATA_BLOB output = { 0, nullptr };
  if (!CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &output)) {
    ThrowGeneric(env);
    return nullptr;
  }

  napi_value result = nullptr;
  const napi_status status = napi_create_buffer_copy(env, output.cbData, output.pbData, nullptr, &result);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  if (status != napi_ok) {
    ThrowGeneric(env);
    return nullptr;
  }
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "protect", nullptr, Protect, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "unprotect", nullptr, Unprotect, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) return nullptr;
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
