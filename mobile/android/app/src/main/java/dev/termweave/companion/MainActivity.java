package dev.termweave.companion;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.net.URI;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;
import java.io.IOException;

public class MainActivity extends Activity {
    private EditText endpoint, code;
    private Button start;
    private String pendingEndpoint, pendingToken;
    private final OkHttpClient client = new OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build();
    private Call pairing;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(32, 48, 32, 32);
        setContentView(layout);
        TextView title = new TextView(this);
        title.setText("TermWeave Companion\nMac에서 발급한 1회용 코드로 연결합니다. 화면 공유와 원격 입력은 직접 허용할 때만 작동합니다.");
        layout.addView(title);
        endpoint = new EditText(this);
        endpoint.setHint("https://중계주소");
        endpoint.setSingleLine(true);
        String saved = Updater.origin(this);
        if (saved != null) endpoint.setText(saved);
        layout.addView(endpoint);
        code = new EditText(this);
        code.setHint("Mac에 표시된 12자리 등록 코드");
        code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        code.setSaveEnabled(false);
        layout.addView(code);
        Button input = new Button(this);
        input.setText("원격 입력 허용 설정");
        layout.addView(input);
        input.setOnClickListener(v -> new AlertDialog.Builder(this)
            .setMessage("화면 공유 중 연결된 Mac에서 터치, 스와이프, 홈, 뒤로 입력을 보낼 수 있습니다. 설정에서 직접 TermWeave 서비스를 허용하십시오.")
            .setPositiveButton("설정 열기", (d,w) -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)))
            .setNegativeButton("취소", null).show());
        start = new Button(this);
        start.setText("코드로 연결 · 화면 공유 시작");
        layout.addView(start);
        start.setOnClickListener(v -> pair());
        Button stop = new Button(this);
        stop.setText("공유 종료 · 연결 해제");
        layout.addView(stop);
        Updater.schedule(this);
        stop.setOnClickListener(v -> {
            if (pairing != null) pairing.cancel();
            stopService(new Intent(this, ProjectionService.class));
            code.setText(""); pendingToken = null; start.setEnabled(true);
        });
    }

    private void pair() {
        try {
            URI origin = URI.create(endpoint.getText().toString().trim());
            String entered = code.getText().toString().trim().toUpperCase(Locale.ROOT);
            if (!"https".equals(origin.getScheme()) || origin.getHost() == null || origin.getUserInfo() != null || origin.getQuery() != null || origin.getFragment() != null || !(origin.getPath().isEmpty() || origin.getPath().equals("/")) || !entered.matches("[A-Z2-7]{12}")) throw new IllegalArgumentException();
            String base = "https://" + origin.getRawAuthority();
            Updater.saveOrigin(this, base);
            pendingEndpoint = "wss://" + origin.getRawAuthority() + "/connect?role=device";
            String body = new JSONObject().put("code", entered).toString();
            code.setText(""); start.setEnabled(false);
            pairing = client.newCall(new Request.Builder().url(base + "/pair")
                .post(RequestBody.create(body, MediaType.get("application/json"))).build());
            pairing.enqueue(new Callback() {
                @Override public void onFailure(Call call, IOException failure) { runOnUiThread(() -> denied()); }
                @Override public void onResponse(Call call, Response response) {
                    try (Response closeable = response) {
                        if (!response.isSuccessful() || response.body() == null || response.body().contentLength() > 2048) throw new IOException();
                        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                        java.io.InputStream input = response.body().byteStream();
                        byte[] block = new byte[512]; int count;
                        while ((count = input.read(block)) != -1) { buffer.write(block, 0, count); if (buffer.size() > 2048) throw new IOException(); }
                        byte[] bytes = buffer.toByteArray();
                        JSONObject result = new JSONObject(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
                        String credential = result.getString("deviceToken");
                        if (credential.length() < 43 || credential.length() > 512 || result.getLong("expiresAt") <= System.currentTimeMillis()) throw new IOException();
                        runOnUiThread(() -> {
                            if (isFinishing() || isDestroyed() || call.isCanceled()) return;
                            pendingToken = credential;
                            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 2);
                            } else beginCapture();
                        });
                    } catch (Exception failure) { runOnUiThread(() -> denied()); }
                }
            });
        } catch (Exception failure) { denied(); }
    }
    private void denied() {
        pendingToken = null;
        if (isFinishing() || isDestroyed()) return;
        start.setEnabled(true);
        Toast.makeText(this, "등록을 완료하지 못했습니다. 중계 주소를 확인하고 Mac에서 새 등록 코드를 발급하십시오.", Toast.LENGTH_LONG).show();
    }
    private void beginCapture() {
        if (pendingToken == null) { denied(); return; }
        MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
        Intent capture = Build.VERSION.SDK_INT >= 34 ? manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay()) : manager.createScreenCaptureIntent();
        startActivityForResult(capture, 1);
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 2 && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) beginCapture();
        else if (request == 2) denied();
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != 1) return;
        if (result == RESULT_OK && data != null && pendingToken != null) {
            startForegroundService(new Intent(this, ProjectionService.class).putExtra("consent", data).putExtra("endpoint", pendingEndpoint).putExtra("token", pendingToken));
        }
        pendingToken = null; start.setEnabled(true);
    }
    /** Read by Updater.onStatus: start the install confirmation directly only while the app is on screen. */
    static volatile boolean visible;

    @Override protected void onPause() { visible = false; super.onPause(); }

    @Override protected void onResume() {
        super.onResume();
        visible = true;
        new Thread(() -> {
            try { Updater.Latest latest = Updater.newer(this); if (latest != null) runOnUiThread(() -> Updater.offer(this, latest)); } catch (Exception ignored) { /* offline: the background job retries */ }
        }).start();
    }
    @Override protected void onDestroy() {
        if (pairing != null) pairing.cancel();
        pendingToken = null;
        super.onDestroy();
    }
}
