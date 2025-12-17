//
//  MainTabView.swift
//  ResearchProject2025
//
//  Created by Kristian on 27.11.25.
//


import SwiftUI

struct MainTabView: View {

    var body: some View {
        TabView {

            NavigationView {
                ContentView()    // your voice assistant screen
            }
            .tabItem {
                Label("Assistant", systemImage: "waveform.circle")
            }

            NavigationView {
                CommandsScreen() // new commands help screen
            }
            .tabItem {
                Label("Commands", systemImage: "list.bullet.rectangle")
            }
        }
    }
}
