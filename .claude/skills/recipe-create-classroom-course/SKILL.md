---
name: recipe-create-classroom-course
description: "Create a Google Classroom course and invite students."
metadata:
  version: 0.22.0
  openclaw:
    category: "recipe"
    domain: "education"
    requires:
      bins:
        - gws
      skills:
        - gws-classroom
---

# Create a Google Classroom Course

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-classroom`

Create a Google Classroom course and invite students.

## Steps

1. Create the course: `gws classroom courses create --json '{"name": "Introduction to CS", "section": "Period 1", "room": "Room 101", "ownerId": "me"}'`
2. Invite a student: `gws classroom invitations create --json '{"courseId": "COURSE_ID", "userId": "student@school.edu", "role": "STUDENT"}'`
3. List enrolled students: `gws classroom courses students list --params '{"courseId": "COURSE_ID"}' --format table`

