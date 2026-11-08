package org.collaborator.app;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The shell's one setting: which Collaborator server to load. Reached from
 * Android's App info ("Additional settings in the app", via
 * APPLICATION_PREFERENCES), the launcher icon's long-press shortcut, and on
 * first launch when the APK was built without a COLLABORATOR_URL.
 */
public class SettingsActivity extends AppCompatActivity {

    private EditText urlField;
    private Button saveButton;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);
        setTitle(R.string.settings_title);

        urlField = findViewById(R.id.server_url);
        saveButton = findViewById(R.id.save);
        Button resetButton = findViewById(R.id.reset);
        TextView status = findViewById(R.id.status);

        String saved = ServerUrl.saved(this);
        String bundled = ServerUrl.bundled(this);
        String current = saved != null ? saved : bundled;

        if (savedInstanceState == null && current != null) {
            urlField.setText(current);
            urlField.setSelection(current.length());
        }
        if (current == null) {
            status.setText(R.string.settings_status_unset);
        } else if (saved != null) {
            status.setText(getString(R.string.settings_status_saved, saved));
        } else {
            status.setText(getString(R.string.settings_status_bundled, bundled));
        }

        // "Reset" only means something when there's a built-in URL to go back to.
        if (saved != null && bundled != null) {
            resetButton.setVisibility(View.VISIBLE);
            resetButton.setText(getString(R.string.settings_reset, bundled));
            resetButton.setOnClickListener(v -> {
                ServerUrl.clear(this);
                relaunch();
            });
        }

        saveButton.setOnClickListener(v -> onSave());
        urlField.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                onSave();
                return true;
            }
            return false;
        });
    }

    private void onSave() {
        final String url = ServerUrl.normalise(urlField.getText().toString());
        if (url == null) {
            urlField.setError(getString(R.string.settings_invalid));
            return;
        }
        saveButton.setEnabled(false);
        saveButton.setText(R.string.settings_checking);
        new Thread(() -> {
            final String problem = probe(url);
            main.post(() -> {
                if (isFinishing()) {
                    return;
                }
                saveButton.setEnabled(true);
                saveButton.setText(R.string.settings_save);
                if (problem == null) {
                    apply(url);
                } else {
                    new AlertDialog.Builder(this)
                            .setTitle(R.string.settings_unreachable_title)
                            .setMessage(getString(R.string.settings_unreachable_body, url, problem))
                            .setPositiveButton(R.string.settings_save_anyway, (d, w) -> apply(url))
                            .setNegativeButton(android.R.string.cancel, null)
                            .show();
                }
            });
        }).start();
    }

    /**
     * GET /api/health. Null if a Collaborator answered (200, or 401/403 when
     * auth is on and the probe has no session), else a short reason.
     */
    private static String probe(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url + "/api/health").openConnection();
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setInstanceFollowRedirects(true);
            int code = conn.getResponseCode();
            if (code == 200 || code == 401 || code == 403) {
                return null;
            }
            return "HTTP " + code;
        } catch (Exception e) {
            String msg = e.getMessage();
            return e.getClass().getSimpleName() + (msg == null ? "" : ": " + msg);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private void apply(String url) {
        ServerUrl.save(this, url);
        relaunch();
    }

    /** Restart the shell so the bridge is rebuilt against the new server. */
    private void relaunch() {
        Intent intent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
    }
}
