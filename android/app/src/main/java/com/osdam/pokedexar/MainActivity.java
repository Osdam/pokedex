package com.osdam.pokedexar;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.osdam.pokedexar.ar.ArCorePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ArCorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
