package com.daonaer.destination;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NavigationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
