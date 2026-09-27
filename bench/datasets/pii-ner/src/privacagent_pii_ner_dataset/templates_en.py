from __future__ import annotations

POSITIVE_TEMPLATES: tuple[str, ...] = (
    "Hi, my name is {NAME} and I live at {ADDRESS}.",
    "Please contact {NAME} regarding the order shipped to {ADDRESS}.",
    "{NAME} works at {ORG} in {LOCATION}.",
    "The delivery for {NAME} should reach {ADDRESS} by Friday.",
    "Employee record: {NAME}, born {DOB}, currently based in {LOCATION}.",
    "{NAME} has been a customer of {ORG} since last year.",
    "Send the invoice to {NAME} at {ADDRESS}.",
    "According to HR, {NAME} joined {ORG} on {DOB}.",
    "We spoke with {NAME}, who resides in {LOCATION}.",
    "{NAME}'s date of birth is {DOB} and their office is at {ADDRESS}.",
    "Passenger {NAME} boarded the flight to {LOCATION}.",
    "{ORG} confirmed that {NAME} is the account holder for {ADDRESS}.",
    "Dear {NAME}, your appointment in {LOCATION} has been rescheduled.",
    "Reference: {NAME}, {ORG}, date of birth {DOB}.",
    "The complaint was filed by {NAME} from {ADDRESS}.",
    "{NAME} previously worked at {ORG} before moving to {LOCATION}.",
    "Contact person {NAME} can be reached near {ADDRESS}.",
    "Patient {NAME}, DOB {DOB}, was referred by {ORG}.",
)

NEGATIVE_TEMPLATES: tuple[str, ...] = (
    "The meeting has been rescheduled to next Thursday.",
    "Our office observes public holidays as per the local calendar.",
    "The weather in the region has been unusually warm this month.",
    "Please review the attached policy document before signing.",
    "The committee will announce the results by the end of the week.",
    "This product is available in three different colors.",
    "The annual report highlights growth across all business units.",
    "Traffic on the highway was heavy during the morning commute.",
    "The library extended its hours for the exam season.",
    "Recycling bins are collected every alternate Tuesday.",
)
