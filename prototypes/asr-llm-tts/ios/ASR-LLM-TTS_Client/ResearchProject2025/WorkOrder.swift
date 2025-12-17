//
//  WorkOrder.swift
//  ResearchProject2025
//
//  Created by Kristian on 25.11.25.
//


import Foundation

public struct WorkOrder: Codable, Identifiable {
    public let id: String
    public var status: String
    public var description: String
    public var timeReported: Int
    public var operations: [Operation]
    public var notes: [Note]
}

public struct Operation: Codable, Identifiable {
    public let id: String
    public var description: String
    public var status: String
}

public struct Note: Codable {
    public let text: String
    public let timestamp: Int
}

