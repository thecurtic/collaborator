package org.collaborator.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.net.Uri;

import com.getcapacitor.CapConfig;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * The server the shell loads. A URL saved in the app's settings screen wins;
 * without one the shell falls back to the URL baked in at `cap sync` time
 * (COLLABORATOR_URL). Changing servers is a settings change, not a rebuild.
 */
final class ServerUrl {

    private static final String PREFS = "collaborator_shell";
    private static final String KEY = "server_url";
    /** capacitor.config.ts's fallback when COLLABORATOR_URL wasn't set. */
    private static final String PLACEHOLDER_HOST = "collaborator.example.com";

    private ServerUrl() {}

    /** The URL the user saved, or null if they never set one. */
    static String saved(Context ctx) {
        return prefs(ctx).getString(KEY, null);
    }

    static void save(Context ctx, String url) {
        prefs(ctx).edit().putString(KEY, url).apply();
    }

    static void clear(Context ctx) {
        prefs(ctx).edit().remove(KEY).apply();
    }

    /** The URL baked into the APK, or null if it's the unconfigured placeholder. */
    static String bundled(Context ctx) {
        try {
            JSONObject server = bundledConfig(ctx).optJSONObject("server");
            String url = server == null ? null : server.optString("url", null);
            if (url == null || url.isEmpty() || isPlaceholder(url)) {
                return null;
            }
            return url;
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    /** What the shell will load: the saved URL, else the bundled one, else null. */
    static String effective(Context ctx) {
        String saved = saved(ctx);
        return saved != null ? saved : bundled(ctx);
    }

    /**
     * Validates and normalises user input: https only (the web app needs a
     * secure context for the microphone), a host, no trailing slash. Returns
     * null when the input isn't usable. A bare host gets https:// prepended.
     */
    static String normalise(String input) {
        if (input == null) {
            return null;
        }
        String s = input.trim();
        if (s.isEmpty()) {
            return null;
        }
        if (!s.contains("://")) {
            s = "https://" + s;
        }
        Uri uri = Uri.parse(s);
        if (!"https".equalsIgnoreCase(uri.getScheme())) {
            return null;
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            return null;
        }
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    static boolean isPlaceholder(String url) {
        return PLACEHOLDER_HOST.equalsIgnoreCase(Uri.parse(url).getHost());
    }

    /**
     * The bundled Capacitor config with server.url and server.allowNavigation
     * pointed at {@code url}; every other setting (plugins etc.) is kept.
     */
    @SuppressWarnings("deprecation")
    static CapConfig configFor(Context ctx, String url) throws IOException, JSONException {
        JSONObject json = bundledConfig(ctx);
        JSONObject server = json.optJSONObject("server");
        if (server == null) {
            server = new JSONObject();
            json.put("server", server);
        }
        server.put("url", url);
        server.put("allowNavigation", new JSONArray().put(Uri.parse(url).getHost()));

        // This constructor has no Context, so it can't see FLAG_DEBUGGABLE;
        // keep the debug-build defaults (WebView inspection, bridge logs).
        boolean debuggable = (ctx.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) {
            JSONObject android = json.optJSONObject("android");
            if (android == null) {
                android = new JSONObject();
                json.put("android", android);
            }
            if (!android.has("webContentsDebuggingEnabled")) {
                android.put("webContentsDebuggingEnabled", true);
            }
            if (!android.has("loggingBehavior") && !json.has("loggingBehavior")) {
                android.put("loggingBehavior", "production");
            }
        }
        return new CapConfig(ctx.getAssets(), json);
    }

    private static JSONObject bundledConfig(Context ctx) throws IOException, JSONException {
        try (InputStream in = ctx.getAssets().open("capacitor.config.json")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
            }
            return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
