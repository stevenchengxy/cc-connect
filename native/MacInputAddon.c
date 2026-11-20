#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// Implemented by MacInput.swift. A session handle is owned by this JS environment.
extern int32_t cc_input_access(int32_t request);
extern int32_t cc_input_start(uint32_t display, void **session);
extern int32_t cc_input_send(void *session, const char *line);
extern void cc_input_stop(void *session);

typedef struct {
    void *session;
} InputState;

typedef struct {
    napi_async_work work;
    napi_deferred deferred;
    bool granted;
} AccessRequest;

static napi_value error(napi_env env, const char *message) {
    napi_throw_error(env, NULL, message);
    return NULL;
}

static napi_value input_result(napi_env env, int32_t result) {
    switch (result) {
        case 0: return NULL; // Node-API treats an empty return as undefined.
        case 1: return error(env, "所选显示器不可用。");
        case 2: return error(env, "control-permission");
        default: return error(env, "无法创建系统输入会话。");
    }
}

static void request_access(napi_env env, void *data) {
    (void)env;
    AccessRequest *request = data;
    // This operation can wait for System Settings. Only the grant check runs
    // on this worker. Input sessions and event posting stay on the JS thread.
    request->granted = cc_input_access(1) != 0;
}

static void complete_request(napi_env env, napi_status status, void *data) {
    AccessRequest *request = data;
    napi_value result;
    if (status == napi_ok && napi_get_boolean(env, request->granted, &result) == napi_ok) {
        napi_resolve_deferred(env, request->deferred, result);
    } else {
        napi_value message;
        if (napi_create_string_utf8(env, "无法检查键鼠控制权限。", NAPI_AUTO_LENGTH, &message) == napi_ok &&
            napi_create_error(env, NULL, message, &result) == napi_ok) {
            napi_reject_deferred(env, request->deferred, result);
        }
    }
    napi_delete_async_work(env, request->work);
    free(request);
}

static napi_value access_input(napi_env env, napi_callback_info info) {
    napi_value argument, result;
    size_t argc = 1;
    bool prompt;
    if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != napi_ok || argc != 1 ||
        napi_get_value_bool(env, argument, &prompt) != napi_ok) {
        return error(env, "键鼠授权参数无效。");
    }
    if (!prompt) {
        if (napi_get_boolean(env, cc_input_access(0) != 0, &result) != napi_ok) {
            return error(env, "无法检查键鼠控制权限。");
        }
        return result;
    }
    AccessRequest *request = calloc(1, sizeof(*request));
    if (!request) return error(env, "无法检查键鼠控制权限。");
    napi_value name;
    if (napi_create_string_utf8(env, "CCConnectInputAccess", NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_promise(env, &request->deferred, &result) != napi_ok ||
        napi_create_async_work(env, NULL, name, request_access, complete_request, request, &request->work) != napi_ok ||
        napi_queue_async_work(env, request->work) != napi_ok) {
        if (request->work) napi_delete_async_work(env, request->work);
        free(request);
        return error(env, "无法检查键鼠控制权限。");
    }
    return result;
}

static napi_value start_input(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argument;
    void *data;
    double display;
    if (napi_get_cb_info(env, info, &argc, &argument, NULL, &data) != napi_ok || argc != 1 ||
        napi_get_value_double(env, argument, &display) != napi_ok ||
        !(display >= 1 && display <= UINT32_MAX) || display != (uint32_t)display) {
        return error(env, "所选显示器不可用。");
    }
    InputState *state = data;
    if (state->session) return error(env, "已有键鼠控制会话。");
    return input_result(env, cc_input_start((uint32_t)display, &state->session));
}

static napi_value send_input(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argument;
    void *data;
    size_t length;
    char line[128];
    if (napi_get_cb_info(env, info, &argc, &argument, NULL, &data) != napi_ok || argc != 1 ||
        napi_get_value_string_utf8(env, argument, NULL, 0, &length) != napi_ok || length == 0 || length >= sizeof(line) ||
        napi_get_value_string_utf8(env, argument, line, sizeof(line), &length) != napi_ok || strlen(line) != length) {
        return error(env, "键鼠指令无效。");
    }
    InputState *state = data;
    if (!state->session) return error(env, "键鼠控制尚未启动。");
    return input_result(env, cc_input_send(state->session, line));
}

static void stop(InputState *state) {
    if (!state->session) return;
    cc_input_stop(state->session);
    state->session = NULL;
}

static napi_value stop_input(napi_env env, napi_callback_info info) {
    void *data;
    if (napi_get_cb_info(env, info, NULL, NULL, NULL, &data) != napi_ok) return error(env, "无法结束键鼠控制。");
    stop(data);
    return NULL;
}

static void cleanup(void *data) {
    stop(data);
    free(data);
}

NAPI_MODULE_INIT() {
    InputState *state = calloc(1, sizeof(*state));
    if (!state) return error(env, "无法创建系统输入会话。");
    if (napi_add_env_cleanup_hook(env, cleanup, state) != napi_ok) {
        free(state);
        return error(env, "无法创建系统输入会话。");
    }
    napi_property_descriptor methods[] = {
        {.utf8name = "access", .method = access_input, .data = state},
        {.utf8name = "start", .method = start_input, .data = state},
        {.utf8name = "send", .method = send_input, .data = state},
        {.utf8name = "stop", .method = stop_input, .data = state},
    };
    if (napi_define_properties(env, exports, sizeof(methods)/sizeof(methods[0]), methods) != napi_ok) {
        return error(env, "无法载入键鼠控制组件。");
    }
    return exports;
}
