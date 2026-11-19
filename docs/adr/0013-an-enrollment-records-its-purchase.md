# An Enrollment records the Purchase that granted it

Each Enrollment points at the Purchase that granted it: the Student's own Individual Purchase, or the Team Licence behind their Claimed Seat (and then the Seat too). Without that link, the PPP check had to guess which Purchase's country applied, and it could pick a refunded Purchase, or a Team Licence the Student had bought for others. Approving a refund had to look for a Claimed Seat before it could end an Enrollment. With the link, both questions have exactly one answer. This supersedes ADR-0004.

## Consequences

Buying and enrolling happen in one transaction, and a Student has at most one Enrollment per course, enforced by the database. Approving a Refund Request ends exactly the Enrollments that point at its Purchase.
