package com.osdam.pokedexar.ar;

import android.opengl.GLES11Ext;
import android.opengl.GLES20;

import com.google.ar.core.Coordinates2d;
import com.google.ar.core.Frame;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

/**
 * Dibuja la imagen de la cámara de ARCore a pantalla completa.
 *
 * Guarda los últimos fotogramas en un anillo de texturas para poder mostrar
 * la imagen que corresponde a la pose que Three.js ya ha dibujado en el
 * WebView: así el Pokémon y la cámara van perfectamente sincronizados aunque
 * el puente nativo → JavaScript tarde un par de fotogramas.
 */
class ArBackgroundRenderer {

    /** Hasta RING_SIZE - 1 fotogramas de retraso (~66 ms a 60 fps). */
    private static final int RING_SIZE = 5;
    /** Resolución de las copias respecto a la pantalla (la cámara no tiene más detalle). */
    private static final float RING_SCALE = 0.75f;

    private static final float[] QUAD_COORDS = {-1f, -1f, +1f, -1f, -1f, +1f, +1f, +1f};
    private static final float[] QUAD_TEX_COORDS = {0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f};

    private static final String VERTEX_SHADER =
            "attribute vec4 a_Position;\n"
                    + "attribute vec2 a_TexCoord;\n"
                    + "varying vec2 v_TexCoord;\n"
                    + "void main() {\n"
                    + "  gl_Position = a_Position;\n"
                    + "  v_TexCoord = a_TexCoord;\n"
                    + "}\n";

    private static final String CAMERA_FRAGMENT_SHADER =
            "#extension GL_OES_EGL_image_external : require\n"
                    + "precision mediump float;\n"
                    + "varying vec2 v_TexCoord;\n"
                    + "uniform samplerExternalOES u_Texture;\n"
                    + "void main() {\n"
                    + "  gl_FragColor = texture2D(u_Texture, v_TexCoord);\n"
                    + "}\n";

    private static final String COPY_FRAGMENT_SHADER =
            "precision mediump float;\n"
                    + "varying vec2 v_TexCoord;\n"
                    + "uniform sampler2D u_Texture;\n"
                    + "void main() {\n"
                    + "  gl_FragColor = texture2D(u_Texture, v_TexCoord);\n"
                    + "}\n";

    private FloatBuffer quadCoords;
    private FloatBuffer cameraTexCoords;
    private FloatBuffer quadTexCoords;

    private int cameraProgram;
    private int cameraPosition;
    private int cameraTexCoord;
    private int copyProgram;
    private int copyPosition;
    private int copyTexCoord;
    private int cameraTextureId = -1;

    private final int[] ringFramebuffers = new int[RING_SIZE];
    private final int[] ringTextures = new int[RING_SIZE];
    private final long[] ringFrameIds = new long[RING_SIZE];
    private int ringWidth;
    private int ringHeight;
    private int screenWidth;
    private int screenHeight;
    private boolean ringReady = false;
    private boolean hasCameraImage = false;
    private boolean texCoordsValid = false;

    int getTextureId() {
        return cameraTextureId;
    }

    void createOnGlThread() {
        int[] textures = new int[1];
        GLES20.glGenTextures(1, textures, 0);
        cameraTextureId = textures[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, cameraTextureId);
        setTextureParams(GLES11Ext.GL_TEXTURE_EXTERNAL_OES);

        quadCoords = floatBuffer(QUAD_COORDS);
        quadTexCoords = floatBuffer(QUAD_TEX_COORDS);
        cameraTexCoords = floatBuffer(new float[QUAD_COORDS.length]);

        cameraProgram = link(VERTEX_SHADER, CAMERA_FRAGMENT_SHADER);
        cameraPosition = GLES20.glGetAttribLocation(cameraProgram, "a_Position");
        cameraTexCoord = GLES20.glGetAttribLocation(cameraProgram, "a_TexCoord");
        copyProgram = link(VERTEX_SHADER, COPY_FRAGMENT_SHADER);
        copyPosition = GLES20.glGetAttribLocation(copyProgram, "a_Position");
        copyTexCoord = GLES20.glGetAttribLocation(copyProgram, "a_TexCoord");
        ringReady = false;
        hasCameraImage = false;
        texCoordsValid = false;
    }

    /** Crea (o recrea) el anillo de texturas al cambiar el tamaño de la pantalla. */
    void onSurfaceChanged(int width, int height) {
        screenWidth = width;
        screenHeight = height;
        if (ringReady) {
            GLES20.glDeleteFramebuffers(RING_SIZE, ringFramebuffers, 0);
            GLES20.glDeleteTextures(RING_SIZE, ringTextures, 0);
        }
        ringWidth = Math.max(1, Math.round(width * RING_SCALE));
        ringHeight = Math.max(1, Math.round(height * RING_SCALE));

        GLES20.glGenFramebuffers(RING_SIZE, ringFramebuffers, 0);
        GLES20.glGenTextures(RING_SIZE, ringTextures, 0);
        for (int i = 0; i < RING_SIZE; i++) {
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, ringTextures[i]);
            setTextureParams(GLES20.GL_TEXTURE_2D);
            GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, ringWidth, ringHeight, 0,
                    GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, ringFramebuffers[i]);
            GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0,
                    GLES20.GL_TEXTURE_2D, ringTextures[i], 0);
            ringFrameIds[i] = -1;
        }
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
        ringReady = true;
        hasCameraImage = false;
    }

    /**
     * Recalcula cómo encaja la imagen de la cámara en la pantalla. Hay que
     * llamarlo tras CADA session.update(): el aviso de cambio de geometría
     * solo llega una vez, a menudo en un fotograma que aún no trae imagen.
     */
    void updateGeometry(Frame frame) {
        if (!frame.hasDisplayGeometryChanged() && texCoordsValid) return;
        quadCoords.position(0);
        cameraTexCoords.position(0);
        frame.transformCoordinates2d(
                Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES, quadCoords,
                Coordinates2d.TEXTURE_NORMALIZED, cameraTexCoords);
        texCoordsValid = true;
    }

    /** Copia la imagen actual de la cámara al anillo, etiquetada con su id de fotograma. */
    void capture(Frame frame, long frameId) {
        updateGeometry(frame);
        if (!ringReady || frame.getTimestamp() == 0) return;

        int slot = (int) (frameId % RING_SIZE);
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, ringFramebuffers[slot]);
        GLES20.glViewport(0, 0, ringWidth, ringHeight);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, cameraTextureId);
        drawQuad(cameraProgram, cameraPosition, cameraTexCoord, cameraTexCoords);
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
        GLES20.glViewport(0, 0, screenWidth, screenHeight);
        ringFrameIds[slot] = frameId;
        hasCameraImage = true;
    }

    /**
     * Dibuja en pantalla el fotograma {@code wantedId} si sigue en el anillo; si
     * es más antiguo usa el más viejo disponible y si no hay ninguno el último.
     */
    void draw(long wantedId, long latestId) {
        if (!hasCameraImage) return;
        int chosen = (int) (latestId % RING_SIZE);
        if (wantedId >= 0 && wantedId < latestId) {
            long oldest = Math.max(0, latestId - RING_SIZE + 1);
            long target = Math.max(wantedId, oldest);
            int slot = (int) (target % RING_SIZE);
            if (ringFrameIds[slot] == target) chosen = slot;
        }
        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        GLES20.glDepthMask(false);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, ringTextures[chosen]);
        drawQuad(copyProgram, copyPosition, copyTexCoord, quadTexCoords);
        GLES20.glDepthMask(true);
    }

    private void drawQuad(int program, int positionAttrib, int texCoordAttrib, FloatBuffer texCoords) {
        quadCoords.position(0);
        texCoords.position(0);
        GLES20.glUseProgram(program);
        GLES20.glVertexAttribPointer(positionAttrib, 2, GLES20.GL_FLOAT, false, 0, quadCoords);
        GLES20.glVertexAttribPointer(texCoordAttrib, 2, GLES20.GL_FLOAT, false, 0, texCoords);
        GLES20.glEnableVertexAttribArray(positionAttrib);
        GLES20.glEnableVertexAttribArray(texCoordAttrib);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(positionAttrib);
        GLES20.glDisableVertexAttribArray(texCoordAttrib);
    }

    private static void setTextureParams(int target) {
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
    }

    private static FloatBuffer floatBuffer(float[] values) {
        FloatBuffer buffer = ByteBuffer.allocateDirect(values.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        buffer.put(values).position(0);
        return buffer;
    }

    private static int link(String vertexSource, String fragmentSource) {
        int program = GLES20.glCreateProgram();
        GLES20.glAttachShader(program, compile(GLES20.GL_VERTEX_SHADER, vertexSource));
        GLES20.glAttachShader(program, compile(GLES20.GL_FRAGMENT_SHADER, fragmentSource));
        GLES20.glLinkProgram(program);
        return program;
    }

    private static int compile(int type, String source) {
        int shader = GLES20.glCreateShader(type);
        GLES20.glShaderSource(shader, source);
        GLES20.glCompileShader(shader);
        return shader;
    }
}
