package com.osdam.pokedexar.ar;

import android.Manifest;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.os.Build;
import android.util.Log;
import android.view.Display;
import android.view.Surface;
import android.view.ViewGroup;
import android.webkit.WebView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.ar.core.Anchor;
import com.google.ar.core.ArCoreApk;
import com.google.ar.core.Camera;
import com.google.ar.core.CameraConfig;
import com.google.ar.core.CameraConfigFilter;
import com.google.ar.core.Config;
import com.google.ar.core.Frame;
import com.google.ar.core.HitResult;
import com.google.ar.core.Plane;
import com.google.ar.core.Session;
import com.google.ar.core.Trackable;
import com.google.ar.core.TrackingState;
import com.google.ar.core.exceptions.CameraNotAvailableException;
import com.google.ar.core.exceptions.UnavailableException;

import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * Realidad aumentada con ARCore para la app nativa.
 *
 * Dibuja la cámara en un GLSurfaceView detrás del WebView (que se vuelve
 * transparente) y en cada fotograma emite el evento "frame" con la pose real
 * del teléfono, la proyección de la cámara, el punto del suelo bajo el centro
 * de la pantalla y la pose del ancla donde se colocó el Pokémon. Three.js
 * dibuja el Pokémon encima con esos datos y responde con {@link #ack} para que
 * el fondo muestre exactamente la imagen de cámara de esa misma pose.
 */
@CapacitorPlugin(
        name = "ArCore",
        permissions = {@Permission(strings = {Manifest.permission.CAMERA}, alias = "camera")}
)
public class ArCorePlugin extends Plugin implements GLSurfaceView.Renderer {

    private static final String TAG = "ArCorePlugin";

    private interface FrameTask {
        void run(Frame frame);
    }

    private final ArBackgroundRenderer background = new ArBackgroundRenderer();
    private final ConcurrentLinkedQueue<FrameTask> frameTasks = new ConcurrentLinkedQueue<>();
    private final float[] poseMatrix = new float[16];
    private final float[] projMatrix = new float[16];
    private final float[] tmpMatrix = new float[16];
    private final float[] lastProjMatrix = new float[16];

    private Session session;
    private GLSurfaceView surfaceView;
    private Drawable savedWebViewBackground;
    private volatile boolean running = false;
    private boolean installRequested = false;
    /** Último fotograma que JavaScript confirmó haber dibujado. */
    private volatile long ackedFrameId = -1;

    // Solo se usan en el hilo de OpenGL.
    private int viewportWidth;
    private int viewportHeight;
    private boolean viewportChanged = false;
    private HitResult centerHit;
    private Anchor anchor;
    private long frameId = -1;
    private long lastTimestamp = 0;
    private boolean projSent = false;

    /* ------------------------------------------------------------------ */
    /* API para JavaScript                                                 */
    /* ------------------------------------------------------------------ */

    @PluginMethod
    public void checkAvailability(PluginCall call) {
        ArCoreApk.Availability availability = ArCoreApk.getInstance().checkAvailability(getContext());
        JSObject result = new JSObject();
        result.put("supported", availability.isSupported());
        result.put("transient", availability.isTransient());
        result.put("status", availability.name());
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        startSession(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            startSession(call);
        } else {
            call.reject("Permiso de cámara denegado", "PERMISSION_DENIED");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            teardown();
            call.resolve();
        });
    }

    /**
     * JavaScript avisa de que ya dibujó el fotograma {@code id}. No devuelve
     * respuesta para no generar tráfico extra en el puente.
     */
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void ack(PluginCall call) {
        Long id = call.getLong("id", -1L);
        if (id != null) ackedFrameId = id;
    }

    /** Crea un ancla de ARCore en el punto del suelo que hay bajo el centro de la pantalla. */
    @PluginMethod
    public void placeAnchor(PluginCall call) {
        if (!running) {
            call.reject("La realidad aumentada no está iniciada");
            return;
        }
        frameTasks.add(frame -> {
            JSObject result = new JSObject();
            if (centerHit == null) {
                result.put("placed", false);
            } else {
                if (anchor != null) anchor.detach();
                anchor = centerHit.createAnchor();
                result.put("placed", true);
            }
            call.resolve(result);
        });
    }

    /* ------------------------------------------------------------------ */
    /* Sesión                                                              */
    /* ------------------------------------------------------------------ */

    private void startSession(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (ArCoreApk.getInstance().requestInstall(getActivity(), !installRequested)
                        == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                    installRequested = true;
                    call.reject("Instala Servicios de Google Play para RA y vuelve a intentarlo", "INSTALL_REQUESTED");
                    return;
                }

                if (session == null) {
                    session = new Session(getContext());
                    selectCameraConfig(session);
                    Config config = new Config(session);
                    config.setPlaneFindingMode(Config.PlaneFindingMode.HORIZONTAL);
                    config.setUpdateMode(Config.UpdateMode.LATEST_CAMERA_IMAGE);
                    config.setFocusMode(Config.FocusMode.AUTO);
                    config.setLightEstimationMode(Config.LightEstimationMode.DISABLED);
                    session.configure(config);
                }

                attachSurface();
                session.resume();
                surfaceView.onResume();
                running = true;
                call.resolve();
            } catch (UnavailableException e) {
                Log.e(TAG, "ARCore no disponible", e);
                teardown();
                call.reject("ARCore no está disponible en este dispositivo", "UNAVAILABLE", e);
            } catch (CameraNotAvailableException e) {
                Log.e(TAG, "Cámara no disponible", e);
                teardown();
                call.reject("No se pudo abrir la cámara", "CAMERA_UNAVAILABLE", e);
            } catch (Exception e) {
                Log.e(TAG, "Error al iniciar ARCore", e);
                teardown();
                call.reject("Error al iniciar ARCore: " + e.getMessage(), "ERROR", e);
            }
        });
    }

    /**
     * Prefiere la cámara a 60 fps (seguimiento y vídeo más fluidos) y sin el
     * sensor de profundidad, que gasta batería y aquí no se usa.
     */
    private void selectCameraConfig(Session session) {
        CameraConfigFilter filter = new CameraConfigFilter(session);
        filter.setDepthSensorUsage(EnumSet.of(CameraConfig.DepthSensorUsage.DO_NOT_USE));
        filter.setTargetFps(EnumSet.of(CameraConfig.TargetFps.TARGET_FPS_60));
        List<CameraConfig> configs = session.getSupportedCameraConfigs(filter);
        if (configs.isEmpty()) {
            filter.setTargetFps(EnumSet.of(CameraConfig.TargetFps.TARGET_FPS_30));
            configs = session.getSupportedCameraConfigs(filter);
        }
        if (!configs.isEmpty()) {
            session.setCameraConfig(configs.get(0));
            Log.i(TAG, "Cámara: " + configs.get(0).getImageSize() + " a " + configs.get(0).getFpsRange());
        }
    }

    /** Coloca el GLSurfaceView detrás del WebView, con su mismo tamaño y posición. */
    private void attachSurface() {
        if (surfaceView != null) return;
        WebView webView = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) webView.getParent();

        surfaceView = new GLSurfaceView(getContext());
        surfaceView.setPreserveEGLContextOnPause(true);
        surfaceView.setEGLContextClientVersion(2);
        surfaceView.setEGLConfigChooser(8, 8, 8, 8, 16, 0);
        surfaceView.setRenderer(this);
        surfaceView.setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);

        ViewGroup.LayoutParams webParams = webView.getLayoutParams();
        ViewGroup.LayoutParams params = webParams instanceof ViewGroup.MarginLayoutParams
                ? new ViewGroup.MarginLayoutParams((ViewGroup.MarginLayoutParams) webParams)
                : new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        parent.addView(surfaceView, 0, params);

        savedWebViewBackground = webView.getBackground();
        webView.setBackgroundColor(Color.TRANSPARENT);
    }

    private void teardown() {
        running = false;
        frameTasks.clear();
        if (surfaceView != null) {
            surfaceView.onPause();
            ViewGroup parent = (ViewGroup) surfaceView.getParent();
            if (parent != null) parent.removeView(surfaceView);
            surfaceView = null;

            WebView webView = getBridge().getWebView();
            if (savedWebViewBackground != null) webView.setBackground(savedWebViewBackground);
            else webView.setBackgroundColor(Color.WHITE);
        }
        if (session != null) {
            session.close();
            session = null;
        }
        anchor = null;
        centerHit = null;
        frameId = -1;
        lastTimestamp = 0;
        ackedFrameId = -1;
        projSent = false;
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (running && session != null) {
            if (surfaceView != null) surfaceView.onPause();
            session.pause();
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (running && session != null) {
            try {
                session.resume();
                if (surfaceView != null) surfaceView.onResume();
            } catch (CameraNotAvailableException e) {
                Log.e(TAG, "No se pudo reanudar la cámara", e);
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        teardown();
        super.handleOnDestroy();
    }

    /* ------------------------------------------------------------------ */
    /* Render (hilo de OpenGL)                                             */
    /* ------------------------------------------------------------------ */

    @Override
    public void onSurfaceCreated(GL10 gl, EGLConfig config) {
        GLES20.glClearColor(0f, 0f, 0f, 1f);
        background.createOnGlThread();
    }

    @Override
    public void onSurfaceChanged(GL10 gl, int width, int height) {
        GLES20.glViewport(0, 0, width, height);
        background.onSurfaceChanged(width, height);
        // La cámara nunca pasa de 60 fps: en pantallas de 90/120 Hz no hace falta redibujar más.
        GLSurfaceView view = surfaceView;
        if (view != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                view.getHolder().getSurface().setFrameRate(60f, Surface.FRAME_RATE_COMPATIBILITY_DEFAULT);
            } catch (Exception e) {
                Log.w(TAG, "No se pudo fijar la tasa de refresco", e);
            }
        }
        viewportWidth = width;
        viewportHeight = height;
        viewportChanged = true;
    }

    @Override
    public void onDrawFrame(GL10 gl) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT | GLES20.GL_DEPTH_BUFFER_BIT);
        Session current = session;
        if (!running || current == null || background.getTextureId() < 0) return;

        try {
            if (viewportChanged) {
                current.setDisplayGeometry(displayRotation(), viewportWidth, viewportHeight);
                viewportChanged = false;
            }
            current.setCameraTextureName(background.getTextureId());
            Frame frame = current.update();
            background.updateGeometry(frame);

            // La pantalla puede refrescar más rápido que la cámara: solo
            // procesamos y enviamos a JavaScript los fotogramas nuevos.
            boolean isNewFrame = frame.getTimestamp() != 0 && frame.getTimestamp() != lastTimestamp;
            if (isNewFrame) {
                lastTimestamp = frame.getTimestamp();
                frameId++;
                Camera camera = frame.getCamera();
                background.capture(frame, frameId);
                centerHit = camera.getTrackingState() == TrackingState.TRACKING ? findFloorHit(frame) : null;
                emitFrame(camera);
            }

            FrameTask task;
            while ((task = frameTasks.poll()) != null) task.run(frame);

            background.draw(ackedFrameId, frameId);
        } catch (CameraNotAvailableException e) {
            Log.w(TAG, "Cámara no disponible en este fotograma", e);
        } catch (Exception e) {
            Log.e(TAG, "Error en el fotograma de ARCore", e);
        }
    }

    /** Busca una superficie horizontal (el suelo o una mesa) bajo el centro de la pantalla. */
    private HitResult findFloorHit(Frame frame) {
        HitResult fallback = null;
        for (HitResult hit : frame.hitTest(viewportWidth / 2f, viewportHeight / 2f)) {
            Trackable trackable = hit.getTrackable();
            if (!(trackable instanceof Plane)) continue;
            Plane plane = (Plane) trackable;
            if (plane.getType() != Plane.Type.HORIZONTAL_UPWARD_FACING
                    || plane.getTrackingState() != TrackingState.TRACKING) continue;
            if (plane.isPoseInPolygon(hit.getHitPose())) return hit;
            if (fallback == null) fallback = hit; // el plano detectado, extendido
        }
        return fallback;
    }

    private void emitFrame(Camera camera) {
        JSObject data = new JSObject();
        TrackingState tracking = camera.getTrackingState();
        data.put("id", frameId);
        data.put("tracking", tracking.name());
        data.put("failure", camera.getTrackingFailureReason().name());

        camera.getDisplayOrientedPose().toMatrix(poseMatrix, 0);
        data.put("pose", toArray(poseMatrix));
        // La proyección casi nunca cambia: solo se envía cuando lo hace.
        camera.getProjectionMatrix(projMatrix, 0, 0.05f, 200f);
        if (!projSent || !Arrays.equals(projMatrix, lastProjMatrix)) {
            System.arraycopy(projMatrix, 0, lastProjMatrix, 0, 16);
            data.put("proj", toArray(projMatrix));
            projSent = true;
        }

        if (centerHit != null) {
            centerHit.getHitPose().toMatrix(tmpMatrix, 0);
            data.put("reticle", toArray(tmpMatrix));
        }
        if (anchor != null && anchor.getTrackingState() == TrackingState.TRACKING) {
            anchor.getPose().toMatrix(tmpMatrix, 0);
            data.put("anchor", toArray(tmpMatrix));
        }
        notifyListeners("frame", data);
    }

    @SuppressWarnings("deprecation")
    private int displayRotation() {
        Display display = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? getActivity().getDisplay()
                : getActivity().getWindowManager().getDefaultDisplay();
        return display != null ? display.getRotation() : 0;
    }

    /** Redondea a 5 decimales (precisión de 10 µm): el JSON pesa menos de la mitad. */
    private static JSArray toArray(float[] values) {
        JSArray array = new JSArray();
        for (float v : values) {
            try {
                array.put(Float.isFinite(v) ? Math.round(v * 1e5) / 1e5 : 0);
            } catch (Exception ignored) {
                array.put(0);
            }
        }
        return array;
    }
}
