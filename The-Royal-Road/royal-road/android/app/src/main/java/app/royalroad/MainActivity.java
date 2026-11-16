package app.royalroad;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;

/**
 * The Royal Road on Android: the phone app (assets/www) in a full-screen web view, plus three things
 * a web page cannot do well on its own: Android's speech recognition, scanning the pairing code,
 * and picking pictures. The page reaches them through window.RoyalAndroid.
 */
public class MainActivity extends Activity {
    private static final String HOME = "https://appassets.androidplatform.net/assets/index.html";
    private static final int REQ_MIC = 1, REQ_FILES = 2;

    private WebView web;
    private SpeechRecognizer recognizer;
    private boolean listening = false;
    private String pendingLang = null;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException e) { /* nothing to open it */ }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("image/*");
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(pick, "Add a picture"), REQ_FILES);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "RoyalAndroid");
        if (state == null || web.restoreState(state) == null) web.loadUrl(HOME);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    /* ---------- talking back to the page ---------- */
    private void emit(final String type, final JSONObject data) {
        runOnUiThread(() -> web.evaluateJavascript(
                "window.__royal && window.__royal.emit(" + JSONObject.quote(type) + "," + data.toString() + ")", null));
    }

    private static JSONObject obj(Object... kv) {
        JSONObject o = new JSONObject();
        try { for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]); } catch (JSONException e) { /* plain values only */ }
        return o;
    }

    /* ---------- speech ---------- */
    private void startListening(String lang) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingLang = lang;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return;
        }
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(new Listener());
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        if (lang != null && !lang.isEmpty()) i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L);
        listening = true;
        // Keep the screen on while listening, so a long dream isn't cut off when the phone would sleep.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        recognizer.startListening(i);
    }

    private void screenMaySleep() { getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); }

    private void stopListening() {
        if (recognizer != null && listening) recognizer.stopListening();
        else emit("end", obj());
    }

    private class Listener implements RecognitionListener {
        @Override public void onReadyForSpeech(Bundle params) { emit("ready", obj()); }
        @Override public void onBeginningOfSpeech() { }
        @Override public void onRmsChanged(float rms) { if (rms > 4) emit("level", obj("v", Math.min(1.0, rms / 10.0))); }
        @Override public void onBufferReceived(byte[] buffer) { }
        @Override public void onEndOfSpeech() { }
        @Override public void onEvent(int type, Bundle params) { }

        @Override
        public void onPartialResults(Bundle b) {
            String t = first(b);
            if (t != null && !t.isEmpty()) emit("result", obj("text", t, "final", false));
        }

        @Override
        public void onResults(Bundle b) {
            listening = false;
            screenMaySleep();
            String t = first(b);
            if (t != null && !t.isEmpty()) emit("result", obj("text", t, "final", true));
            emit("end", obj());
        }

        @Override
        public void onError(int code) {
            listening = false;
            screenMaySleep();
            String c;
            switch (code) {
                case SpeechRecognizer.ERROR_NO_MATCH:
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: c = "no-speech"; break;
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: c = "not-allowed"; break;
                case SpeechRecognizer.ERROR_NETWORK:
                case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                case SpeechRecognizer.ERROR_SERVER: c = "network"; break;
                case SpeechRecognizer.ERROR_AUDIO: c = "audio-capture"; break;
                case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
                case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE: c = "language-not-supported"; break;
                case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                case SpeechRecognizer.ERROR_CLIENT: c = "aborted"; break;
                default: c = "other";
            }
            emit("error", obj("code", c));
            emit("end", obj());
        }

        private String first(Bundle b) {
            ArrayList<String> r = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            return r == null || r.isEmpty() ? null : r.get(0);
        }
    }

    /* ---------- pairing code ---------- */
    private void scanCode() {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(this, options);
        scanner.startScan()
                .addOnSuccessListener(code -> emit("scan", obj("text", code.getRawValue() == null ? "" : code.getRawValue())))
                .addOnCanceledListener(() -> emit("scan", obj("cancelled", true)))
                .addOnFailureListener(e -> emit("scan", obj("error", "The code scanner is not available on this phone. Paste the pairing code instead.")));
    }

    /* ---------- the bridge the page sees as window.RoyalAndroid ---------- */
    private class Bridge {
        @JavascriptInterface public boolean speechAvailable() { return SpeechRecognizer.isRecognitionAvailable(MainActivity.this); }
        @JavascriptInterface public void startListening(final String lang) { runOnUiThread(() -> MainActivity.this.startListening(lang)); }
        @JavascriptInterface public void stopListening() { runOnUiThread(MainActivity.this::stopListening); }
        @JavascriptInterface public void abortListening() { runOnUiThread(() -> { if (recognizer != null) recognizer.cancel(); listening = false; screenMaySleep(); emit("end", obj()); }); }
        @JavascriptInterface public void scanCode() { runOnUiThread(MainActivity.this::scanCode); }
    }

    /* ---------- system callbacks ---------- */
    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != REQ_MIC) return;
        String lang = pendingLang; pendingLang = null;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startListening(lang);
        else { emit("error", obj("code", "not-allowed")); emit("end", obj()); }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != REQ_FILES || fileCallback == null) return;
        Uri[] uris = null;
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                uris = new Uri[n];
                for (int i = 0; i < n; i++) uris[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                uris = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(uris);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        // Let the page go back a screen first; leave the app only from the main screen.
        web.evaluateJavascript("window.__royalBack ? window.__royalBack() : false", value -> {
            if (!"true".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (recognizer != null && listening) recognizer.stopListening();
    }

    @Override
    protected void onDestroy() {
        if (recognizer != null) recognizer.destroy();
        web.destroy();
        super.onDestroy();
    }
}
