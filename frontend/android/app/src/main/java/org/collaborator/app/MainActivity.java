package org.collaborator.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleSendIntent(getIntent());
        handleViewIntent(getIntent());
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                askWebAppToGoBack();
            }
        });
    }

    /**
     * Back button / gesture: the web app keeps its own back stack (open
     * sheets, detail views, pushed screens) and takes one step back through
     * window.collaboratorBack(). Only when it has nowhere left to go does the
     * app go to the background, like any Android app's home screen.
     */
    private void askWebAppToGoBack() {
        String js = "(function(){try{return !!(window.collaboratorBack"
                + " && window.collaboratorBack());}catch(e){return false;}})()";
        bridge.getWebView().evaluateJavascript(js, handled -> {
            if (!"true".equals(handled)) {
                moveTaskToBack(true);
            }
        });
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // launchMode=singleTask: shares while the app is alive land here.
        handleSendIntent(intent);
        handleViewIntent(intent);
    }

    /**
     * Notification taps: collaborator://open/<path>?<query> (the ntfy click
     * link with notifications.open_in: app) loads <server URL>/<path>?<query>
     * in this WebView, where the web app reads ?open= as it would in a
     * browser.
     */
    private void handleViewIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return;
        }
        Uri data = intent.getData();
        if (data == null || !"collaborator".equals(data.getScheme())
                || !"open".equals(data.getHost())) {
            return;
        }
        String base = bridge.getServerUrl();
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        String path = data.getEncodedPath();
        String query = data.getEncodedQuery();
        StringBuilder url = new StringBuilder(base);
        url.append(path == null || path.isEmpty() ? "/" : path);
        if (query != null && !query.isEmpty()) {
            url.append('?').append(query);
        }
        // Consume it so a config-change recreate doesn't re-open.
        intent.setData(null);
        final String target = url.toString();
        bridge.getWebView().post(() -> bridge.getWebView().loadUrl(target));
    }

    /**
     * Share sheet → Scratch. The web app owns the capture flow (it reads
     * ?text= on load and posts to /api/scratch), so the shell's only job is
     * forwarding the shared text as a query param on the remote URL.
     */
    private void handleSendIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) {
            return;
        }
        if (!"text/plain".equals(intent.getType())) {
            return;
        }
        String shared = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (shared == null || shared.trim().isEmpty()) {
            return;
        }
        StringBuilder url = new StringBuilder(bridge.getServerUrl());
        url.append("?text=").append(Uri.encode(shared));
        if (subject != null && !subject.trim().isEmpty()) {
            url.append("&title=").append(Uri.encode(subject));
        }
        // Consume the extra so a config-change recreate doesn't re-share.
        intent.removeExtra(Intent.EXTRA_TEXT);
        final String target = url.toString();
        bridge.getWebView().post(() -> bridge.getWebView().loadUrl(target));
    }
}
